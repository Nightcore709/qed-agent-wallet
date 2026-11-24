/**
 * The co-signer as the rail sees it: a port with an address and a verdict, nothing else.
 *
 * CosignerCore wraps the release's unmodified PolicyEngine and adds two things the release left in memory or left
 * out (baseline W-02, W-05), without touching the engine's code:
 *   - a durable replay set: every nonce it has signed is written to its own state file and seeded back into the
 *     engine at start, so a restart does not let a nonce be co-signed twice;
 *   - owner-authenticated policy supersession: standing policies carry a sequence number; the co-signer verifies the
 *     owner's signature when a policy is registered or revoked, remembers the highest sequence, and refuses a tick
 *     under an older or revoked policy (check P0) before the engine is even asked.
 *
 * Two hosts exist. InProcessCosigner (here) runs the core as an object in the rail's process, which is what the
 * release's hosted app did (baseline X-04, W-08). ProcessCosigner (cosigner-client.ts) runs the same core in its
 * own process with a key the rail never loads. The state reports which one is active as `roles.cosignerIsolation`.
 */
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, writeFileSync, writeSync } from "node:fs";
import { dirname, join } from "node:path";
import { createPublicClient, getAddress, hashMessage, http, recoverMessageAddress, type Address, type Hex, type LocalAccount } from "viem";
import type { Vendored } from "./vendored.ts";
import type { AuthorityView } from "../types.ts";
import { createForkedPolicyEngine } from "./cosigner-engine.ts";
import { routeChain } from "./chain-socket.ts";
import type { D7Config, Reservation } from "./authority-ledger.ts";

export interface CosignerConfig {
  rpcUrl: string;
  /**
   * The chain's IPC socket (chain-socket.ts, F-14): `rpcUrl` names a port browsers refuse and is answered over this
   * socket in whichever process the co-signer runs. Absent for a chain this process already routes.
   */
  chainSocket?: string;
  chainId: number;
  vault: Address;
  lens: Address;
  escrow: Address;
  owner: Address;
  denylist: Address[];
  deployBlock: string;
  recordsDir: string;
  /**
   * "release" (default): the release's unmodified PolicyEngine (baseline parity). "fork": rail/cosigner-engine.ts, the
   * same engine with owner signatures checked as the vault checks them (ERC-1271 for a passkey account) and amounts in
   * the vault asset's units (decision D-A, docs/r7/00-ARCHITECTURE-DECISIONS.md). Every workspace created through POST /workspaces uses "fork".
   */
  engine?: "release" | "fork";
  /**
   * Check C12, for the fork only. "release" (default): the release's earned allowance in the vault asset's units (D-A).
   * "d7": the authority budget of R7 decision D7 (rail/authority-ledger.ts), configured by `d7`; owner grants and the
   * certificates not yet used are kept in this co-signer's durable state. The release's engine has no "d7".
   */
  authority?: "release" | "d7";
  d7?: D7Config;
  /**
   * Money-model S5, for the fork only: an order's best-execution tolerance never asks for less than this many base units
   * of the output token (scripts/fork-cosigner.mjs change 6). Set for a workspace whose currency set is not the default;
   * absent everywhere else, where τ is the release's.
   */
  minToleranceUnits?: number;
}

/** The message an owner signs (EIP-191, by passkey through ERC-1271 for a passkey account) to add to the agent's authority budget. */
export const authorityGrantMessage = (vault: Address, amount: bigint, nonce: string) => `QED authority grant\nvault: ${getAddress(vault)}\nadd to the agent's authority budget, as granted and not earned: ${amount.toString()} base units of the vault's asset\nnonce: ${nonce}`;
const GRANT_RE = /^QED authority grant\nvault: (0x[0-9a-fA-F]{40})\nadd to the agent's authority budget, as granted and not earned: ([1-9]\d{0,29}) base units of the vault's asset\nnonce: ([A-Za-z0-9._:-]{8,128})$/;
interface GrantRecord { nonce: string; amount: string; message: string; signature: Hex; at: string }

/**
 * D-K1b (R13): the message an owner signs (EIP-191, by passkey through ERC-1271, as for a grant) to set the caps K1 puts on
 * earned authority (rail/earned-authority.ts). The window is the operator's and is stated so the owner reads it; the two
 * amounts are what the owner allows. The operator's caps stay the ceiling: a signed cap can only keep or lower what counts.
 */
export const earnedCapsMessage = (vault: Address, windowSeconds: number, perWindow: bigint, perPayer: bigint, nonce: string) =>
  `QED earned-authority caps\nvault: ${getAddress(vault)}\nin any ${windowSeconds} seconds of chain time, count at most this much as earned: ${perWindow.toString()} base units of the vault's asset\nfrom any one payer in that time, at most: ${perPayer.toString()} base units\nnonce: ${nonce}`;
const CAPS_RE = /^QED earned-authority caps\nvault: (0x[0-9a-fA-F]{40})\nin any (\d{1,9}) seconds of chain time, count at most this much as earned: (\d{1,30}) base units of the vault's asset\nfrom any one payer in that time, at most: (\d{1,30}) base units\nnonce: ([A-Za-z0-9._:-]{8,128})$/;
export type CapName = "perWindow" | "perPayer";
const CAP_NAMES: CapName[] = ["perWindow", "perPayer"];
/** One cap's owner-signed state: the value in force (null: none signed, the operator's applies) and a raise waiting out its delay. */
interface CapSide { now: string | null; next: { value: string; from: number; nonce: string } | null }
interface CapsRecord { nonce: string; message: string; signature: Hex; at: string; asked: Record<CapName, string>; outcome: Record<CapName, "lowered" | "kept" | "raise-waits"> }
interface CapsState { perWindow: CapSide; perPayer: CapSide; delaySeconds: number | null; records: CapsRecord[] }
/** The caps as the owner set them and as they apply at a moment (ms on the rail's clock): what the screens and the escrow read. */
export interface EarnedCapsView {
  ceiling: { windowSeconds: number; perWindow: string; perPayer: string };
  owner: Record<CapName, string | null>;
  inForce: Record<CapName, string>;
  pending: { cap: CapName; value: string; from: number; nonce: string }[];
  delaySeconds: number | null;
  signed: number;
}

export interface CosignerPort {
  readonly isolation: "separate-process" | "in-process";
  address(): Promise<Address>;
  alive(): Promise<boolean>;
  configure(cfg: CosignerConfig): Promise<void>;
  /** The release's TradeResponse plus `record`: the text of the decision record that was written. */
  evaluateTrade(req: any): Promise<any>;
  /**
   * An owner-instructed payment (the release's PolicyEngine.evaluate: C1, C2, C3, C6, C9 to C12). Returns the
   * release's CertResponse plus `record`. Purchases against a vendor invoice are not certified on the rail: it has
   * no vendor registry, price list or escrow for the main treasury.
   */
  evaluatePayment(req: any): Promise<any>;
  /** Registers an owner-signed standing policy; older sequences are refused from then on. */
  registerPolicy(policy: any, policySig: Hex): Promise<{ sequence: number }>;
  /** Owner-signed revocation of every policy up to a sequence. */
  revokePolicies(message: string, signature: Hex): Promise<{ revokedThrough: number }>;
  /** R7 D7: registers an owner-signed grant (authorityGrantMessage), checked as the vault checks owner signatures. Same message again: the same answer. */
  registerGrant(message: string, signature: Hex): Promise<{ nonce: string; amount: string; granted: string; duplicate: boolean }>;
  /**
   * D-K1b: registers owner-signed earned-authority caps (earnedCapsMessage), checked as the vault checks owner signatures.
   * A cap lower than the one in force applies at once; a higher one waits `delaySeconds` from `nowMs`. Same message again:
   * the same answer.
   */
  registerCaps(message: string, signature: Hex, at: { nowMs: number; delaySeconds: number }): Promise<EarnedCapsView & { nonce: string; duplicate: boolean; outcome: Record<CapName, "lowered" | "kept" | "raise-waits"> }>;
  /** D-K1b: the earned-authority caps at a moment (ms): the operator's ceiling, the owner's, what applies, what waits. */
  earnedCaps(nowMs: number): Promise<EarnedCapsView | null>;
  /** R7 D7: the authority budget as the co-signer computes it now (a read: nothing is signed or reserved). */
  authority(): Promise<AuthorityView | { rule: "release" }>;
  /** The address of the key the co-signer would switch to. Nothing changes until commitRotation. */
  prepareRotation(): Promise<Address>;
  /** Switch to the prepared key, once the owner has registered it in the vault. Returns the active address. */
  commitRotation(expected: Address): Promise<Address>;
  stop(): Promise<void>;
}

export const policySequence = (nonce: unknown): number | null => {
  const m = typeof nonce === "string" ? /^rail-policy-[0-9a-f-]{8}-(\d{1,9})$/.exec(nonce) : null;
  return m ? Number(m[1]) : null;
};
export const revocationMessage = (vault: Address, through: number) => `QED treasury policy revocation\nvault: ${getAddress(vault)}\nrevoke every policy through sequence: ${through}`;

interface Persisted { nonces: string[]; policySequence: number; revokedThrough: number; keyVersion: number; grants?: GrantRecord[]; reservations?: Reservation[]; caps?: CapsState }
/** How a host supplies the co-signer's keys: version 1 at first start, the next version at each rotation. */
export type KeySource = (version: number) => LocalAccount;
/** The same for every workspace scope: each workspace's vault set has its own co-signer key (R7 D4). */
export type ScopedKeySource = (scope: string, version: number) => LocalAccount;
export const SCOPE_RE = /^[a-z0-9][a-z0-9-]{2,62}$/;

/**
 * Durable state of all scopes in one file (mode 600, written atomically). A file written before scopes existed holds
 * one scope's state at its top level; it is the baseline workspace's, and is read as such.
 */
export class ScopeStateFile {
  private all: Record<string, Persisted> = {};
  readonly path: string;
  constructor(path: string, legacyScope = "baseline") {
    this.path = path;
    if (!existsSync(path)) return;
    const raw = JSON.parse(readFileSync(path, "utf8"));
    this.all = raw && typeof raw === "object" && raw.scopes ? raw.scopes : raw && Array.isArray(raw.nonces) ? { [legacyScope]: raw as Persisted } : {};
  }
  get(scope: string): Persisted | undefined { return this.all[scope]; }
  put(scope: string, s: Persisted) {
    this.all[scope] = s;
    mkdirSync(dirname(this.path), { recursive: true });
    const tmp = `${this.path}.tmp`;
    const fd = openSync(tmp, "w", 0o600);
    try { writeSync(fd, JSON.stringify({ scopes: this.all })); fsyncSync(fd); } finally { closeSync(fd); }
    renameSync(tmp, this.path);
  }
}

export class CosignerCore {
  private engine: any = null;
  private cfg: CosignerConfig | null = null;
  private state: Persisted = { nonces: [], policySequence: 0, revokedThrough: 0, keyVersion: 1 };
  private readonly v: Vendored;
  private readonly keys: KeySource;
  private readonly file: ScopeStateFile;
  private readonly scope: string;
  /**
   * Certifications and grants of one scope run one at a time: a check and what it records (the nonce of C6, the budget
   * and reservation of C12, a grant's nonce) cannot interleave with another's. Reads do not wait.
   */
  private lane: Promise<unknown> = Promise.resolve();
  private serial<T>(f: () => Promise<T>): Promise<T> {
    const run = this.lane.then(f, f);
    this.lane = run.catch(() => undefined);
    return run;
  }
  constructor(v: Vendored, keys: KeySource, file: ScopeStateFile, scope = "baseline") {
    this.v = v;
    this.keys = keys;
    this.file = file;
    this.scope = scope;
    const saved = file.get(scope);
    if (saved) this.state = { ...this.state, ...saved };
  }
  private get key(): LocalAccount { return this.keys(this.state.keyVersion); }
  get address(): Address { return this.key.address; }
  /**
   * R13 review fix F3: proof that this process still signs with the scope's active key, for the deployed image's
   * isolation check (scripts/deploy/isolation-check.ts). An EIP-191 signature of one fixed text: never an EIP-712
   * digest, so it can stand for no certificate, policy or grant the vault or the escrow would accept.
   */
  selfTest(): Promise<Hex> { return this.key.signMessage({ message: COSIGNER_SELF_TEST }); }
  prepareRotation(): Address { return this.keys(this.state.keyVersion + 1).address; }
  commitRotation(expected: Address): Address {
    if (getAddress(this.address) === getAddress(expected)) return this.address; // already switched
    if (getAddress(this.prepareRotation()) !== getAddress(expected)) throw new Error("the approved key is not the prepared one");
    this.state.keyVersion++;
    this.save();
    if (this.cfg) this.configure(this.cfg);
    return this.address;
  }

  configure(cfg: CosignerConfig) {
    if (cfg.authority === "d7" && (cfg.engine !== "fork" || !cfg.d7)) throw new Error('authority "d7" needs the fork engine and its d7 configuration');
    this.cfg = cfg;
    if (cfg.chainSocket) routeChain(cfg.rpcUrl, cfg.chainSocket);
    const chain = new this.v.chain.Chain$(cfg.rpcUrl, cfg.chainId);
    const Engine = cfg.engine === "fork" ? createForkedPolicyEngine(this.v) : this.v.cosigner.PolicyEngine;
    const d7 = { ...(cfg.authority === "d7" ? { authority: "d7" as const, d7: cfg.d7 } : {}), ...(cfg.engine === "fork" && cfg.minToleranceUnits ? { minToleranceUnits: cfg.minToleranceUnits } : {}) };
    this.engine = new Engine(chain as never, this.key, { vault: cfg.vault, lens: cfg.lens, escrow: cfg.escrow, owner: cfg.owner, vendorKeys: {}, catalogPrices: {}, denylist: cfg.denylist, deployBlock: BigInt(cfg.deployBlock), recordsDir: cfg.recordsDir, ...d7 });
    // The engine keeps its replay set in a private in-memory field; restore it from the durable copy.
    for (const n of this.state.nonces) this.engine.seenNonces.add(n);
    // R7 D7: the owner's grants and the certificates not yet used live here, durably; the engine reads them.
    if (this.authorityRule === "d7") this.engine.setAuthorityState(() => (this.state.grants ?? []).map((g) => ({ nonce: g.nonce, amount: g.amount, at: g.at })), this.state.reservations ?? [], (nowMs: number) => this.ownerCapsAt(nowMs));
  }
  /** D-K1b: the owner's caps in force at `nowMs` (null: none signed for that cap). A raise counts once its delay has ended. */
  ownerCapsAt(nowMs: number): Record<CapName, string | null> {
    const c = this.state.caps;
    const at = (side: CapSide | undefined) => (!side ? null : side.next && side.next.from <= nowMs ? side.next.value : side.now);
    return { perWindow: at(c?.perWindow), perPayer: at(c?.perPayer) };
  }
  private ceiling(): EarnedCapsView["ceiling"] | null {
    const e = this.cfg?.d7?.earnedCap;
    if (this.authorityRule !== "d7" || !this.cfg?.d7) return null;
    if (e) return { windowSeconds: e.windowSeconds, perWindow: String(e.perWindow), perPayer: String(e.perPayer) };
    const one = 10n ** BigInt(this.cfg.d7.decimals);
    return { windowSeconds: 30 * 86_400, perWindow: (1000n * one).toString(), perPayer: (250n * one).toString() };
  }
  capsView(nowMs: number): EarnedCapsView | null {
    const ceiling = this.ceiling();
    if (!ceiling) return null;
    const owner = this.ownerCapsAt(nowMs), c = this.state.caps;
    const min = (a: string, b: string | null) => (b !== null && BigInt(b) < BigInt(a) ? b : a);
    const pending = CAP_NAMES.flatMap((cap) => { const n = c?.[cap].next; return n && n.from > nowMs ? [{ cap, value: n.value, from: n.from, nonce: n.nonce }] : []; });
    return { ceiling, owner, inForce: { perWindow: min(ceiling.perWindow, owner.perWindow), perPayer: min(ceiling.perPayer, owner.perPayer) }, pending, delaySeconds: c?.delaySeconds ?? null, signed: c?.records.length ?? 0 };
  }
  /**
   * D-K1b: the owner's earned-authority caps. The message must name this vault and the operator's window, ask for no more
   * than the operator's caps (the ceiling), carry a fresh nonce, and be signed by the vault's owner as the vault checks
   * signatures. Each cap then moves at once to the lower of what is in force and what is asked (a tightening, which also
   * drops a raise still waiting for that cap: an earlier loosening never undoes a later tightening), and a higher value
   * waits `delaySeconds` from `nowMs` (the owner account's protection delay, 72 hours by default) before it counts; asked
   * again, the wait starts again. Stored durably with the message and signature.
   */
  registerCaps(message: string, signature: Hex, at: { nowMs: number; delaySeconds: number }) { return this.serial(() => this.capsNow(message, signature, at)); }
  private async capsNow(message: string, signature: Hex, at: { nowMs: number; delaySeconds: number }) {
    if (!this.engine) throw new Error("co-signer not configured");
    const ceiling = this.ceiling();
    if (!ceiling) throw new Error("this workspace's C12 is the release's earned allowance: earned-authority caps apply to the authority budget (R7 D7) only");
    const m = typeof message === "string" ? CAPS_RE.exec(message) : null;
    if (!m || getAddress(m[1] as Address) !== getAddress(this.cfg!.vault)) throw new Error("not an earned-authority caps message for this vault");
    if (Number(m[2]) !== ceiling.windowSeconds) throw new Error(`the caps name a window of ${m[2]} seconds; this installation's window is ${ceiling.windowSeconds} seconds`);
    const asked: Record<CapName, string> = { perWindow: BigInt(m[3]).toString(), perPayer: BigInt(m[4]).toString() };
    for (const cap of CAP_NAMES) if (BigInt(asked[cap]) > BigInt(ceiling[cap])) throw new Error(`the ${cap === "perWindow" ? "window" : "per-payer"} cap asked, ${asked[cap]}, is above the operator's ceiling of ${ceiling[cap]}`);
    if (!Number.isSafeInteger(at.nowMs) || !Number.isSafeInteger(at.delaySeconds) || at.delaySeconds < 0) throw new Error("the time and the delay are whole numbers");
    const st: CapsState = this.state.caps ?? { perWindow: { now: null, next: null }, perPayer: { now: null, next: null }, delaySeconds: null, records: [] };
    const known = st.records.find((r) => r.nonce === m[5]);
    if (known) {
      if (known.message !== message) throw new Error("that caps nonce was already used for other caps");
      return { ...this.capsView(at.nowMs)!, nonce: known.nonce, duplicate: true, outcome: known.outcome };
    }
    if (!(await this.signedByOwner(message, signature))) throw new Error("the caps are not signed by the vault owner");
    const outcome = {} as Record<CapName, "lowered" | "kept" | "raise-waits">;
    for (const cap of CAP_NAMES) {
      const side = st[cap];
      if (side.next && side.next.from <= at.nowMs) { side.now = side.next.value; side.next = null; } // a raise whose delay ended
      const inForce = BigInt(side.now ?? ceiling[cap]), want = BigInt(asked[cap]);
      if (want <= inForce) { side.now = want.toString(); side.next = null; outcome[cap] = want < inForce ? "lowered" : "kept"; }
      else { side.next = { value: want.toString(), from: at.nowMs + at.delaySeconds * 1000, nonce: m[5] }; outcome[cap] = "raise-waits"; }
    }
    st.delaySeconds = at.delaySeconds;
    st.records.push({ nonce: m[5], message, signature, at: new Date(at.nowMs).toISOString(), asked, outcome });
    this.state.caps = st;
    this.save();
    return { ...this.capsView(at.nowMs)!, nonce: m[5], duplicate: false, outcome };
  }
  get authorityRule(): "release" | "d7" { return this.cfg?.authority === "d7" ? "d7" : "release"; }
  /** After the engine signed under the authority budget, its reservations are made durable with the nonce. */
  private keepReservations() {
    if (this.authorityRule === "d7") this.state.reservations = this.engine.authorityReservations();
  }
  private save() {
    this.file.put(this.scope, this.state);
  }
  private async vaultOwner(): Promise<Address> {
    const pub = createPublicClient({ transport: http(this.cfg!.rpcUrl) });
    return getAddress((await pub.readContract({ address: this.cfg!.vault, abi: this.v.abi.QEDVaultAbi, functionName: "owner" })) as Address);
  }
  get engineName(): "release" | "fork" { return this.cfg?.engine === "fork" ? "fork" : "release"; }
  /** The vault owner's signature on `message`, checked as the vault checks signatures: ECDSA for an owner without code, ERC-1271 otherwise. */
  private async signedByOwner(message: string, signature: Hex): Promise<boolean> {
    const pub = createPublicClient({ transport: http(this.cfg!.rpcUrl) });
    const owner = await this.vaultOwner();
    const code = await pub.getCode({ address: owner });
    if (!code || code === "0x") return getAddress(await recoverMessageAddress({ message, signature })) === owner;
    const magic = await pub.readContract({ address: owner, abi: [{ type: "function", name: "isValidSignature", stateMutability: "view", inputs: [{ name: "hash", type: "bytes32" }, { name: "signature", type: "bytes" }], outputs: [{ name: "", type: "bytes4" }] }], functionName: "isValidSignature", args: [hashMessage(message), signature] }).catch(() => "0x");
    return String(magic).toLowerCase() === "0x1626ba7e";
  }

  async registerPolicy(policy: any, policySig: Hex) {
    const seq = policySequence(policy?.nonce);
    if (seq === null) throw new Error("the policy carries no sequence number");
    if (!(await this.signedByOwner(this.v.treasury.policyMessage(policy), policySig))) throw new Error("the policy is not signed by the vault owner");
    if (seq > this.state.policySequence) { this.state.policySequence = seq; this.save(); }
    return { sequence: this.state.policySequence };
  }
  async revokePolicies(message: string, signature: Hex) {
    const m = /^QED treasury policy revocation\nvault: (0x[0-9a-fA-F]{40})\nrevoke every policy through sequence: (\d{1,9})$/.exec(message);
    if (!m || getAddress(m[1] as Address) !== getAddress(this.cfg!.vault)) throw new Error("not a revocation for this vault");
    if (!(await this.signedByOwner(message, signature))) throw new Error("the revocation is not signed by the vault owner");
    this.state.revokedThrough = Math.max(this.state.revokedThrough, Number(m[2]));
    this.save();
    return { revokedThrough: this.state.revokedThrough };
  }

  /**
   * R7 D7: an owner grant. The message must name this vault, a whole positive amount and a fresh nonce, and be signed
   * by the vault's owner as the vault checks signatures (ERC-1271 for a passkey account). Stored durably; the budget
   * reports it as granted, never as earned. The same message again (a retried job) answers the same and adds nothing.
   */
  registerGrant(message: string, signature: Hex) { return this.serial(() => this.grantNow(message, signature)); }
  private async grantNow(message: string, signature: Hex) {
    if (!this.engine) throw new Error("co-signer not configured");
    if (this.authorityRule !== "d7") throw new Error("this workspace's C12 is the release's earned allowance: grants apply to the authority budget (R7 D7) only");
    const m = typeof message === "string" ? GRANT_RE.exec(message) : null;
    if (!m || getAddress(m[1] as Address) !== getAddress(this.cfg!.vault)) throw new Error("not an authority grant for this vault");
    const grants = this.state.grants ?? [];
    const total = () => grants.reduce((s, g) => s + BigInt(g.amount), 0n).toString();
    const known = grants.find((g) => g.nonce === m[3]);
    if (known) {
      if (known.message !== message) throw new Error("that grant nonce was already used for another grant");
      return { nonce: known.nonce, amount: known.amount, granted: total(), duplicate: true };
    }
    if (!(await this.signedByOwner(message, signature))) throw new Error("the grant is not signed by the vault owner");
    grants.push({ nonce: m[3], amount: BigInt(m[2]).toString(), message, signature, at: new Date().toISOString() });
    this.state.grants = grants;
    this.save();
    return { nonce: m[3], amount: BigInt(m[2]).toString(), granted: total(), duplicate: false };
  }
  /** R7 D7: the budget as this co-signer computes it now; the rail's payment preview shows exactly this. */
  async authority(): Promise<AuthorityView | { rule: "release" }> {
    if (!this.engine) throw new Error("co-signer not configured");
    if (this.authorityRule !== "d7") return { rule: "release" };
    return { ...(await this.engine.authorityView()), earnedCaps: this.capsView(Date.now()) ?? undefined };
  }

  /** A refusal decided here, recorded in the release's record format so every verdict looks the same. */
  private refuse(req: any, check: { id: string; name: string; detail: string }) {
    const checks = [{ ...check, pass: false }];
    const core = { schema: "qed.decision-record/v1", cosigner: this.key.address, chainId: this.cfg!.chainId, vault: this.cfg!.vault, mandateHash: this.v.eip712.mandateHash(req.mandate), request: { kind: "policy-trade", instruction: req.instruction, brainEngine: req.brainEngine, nonce: req.nonce, tokenIn: req.tokenIn, tokenOut: req.tokenOut, amountIn: req.amountIn, recipient: req.recipient, policy: req.policy ?? null }, checks, verdict: "REFUSED" };
    const canonical = this.v.records.canonical(core), evidenceHash = this.v.records.hashRecord(core);
    const recordPath = join(this.cfg!.recordsDir, `${evidenceHash}.json`);
    const record = JSON.stringify({ core: JSON.parse(canonical), canonical, evidenceHash, certificate: null, signature: null }, null, 2);
    writeFileSync(recordPath, record);
    return { approved: false, evidenceHash, recordPath, checks, reasons: [`${check.id} ${check.name}: ${check.detail}`], record, engine: this.engineName };
  }

  evaluateTrade(req: any) { return this.serial(() => this.tradeNow(req)); }
  private async tradeNow(req: any) {
    if (!this.engine) throw new Error("co-signer not configured");
    if (req.policy) {
      const seq = policySequence(req.policy.nonce);
      const name = "Standing policy is the owner's current one (not superseded, not revoked)";
      if (seq === null) return this.refuse(req, { id: "P0", name, detail: "the policy carries no sequence number" });
      if (seq <= this.state.revokedThrough) return this.refuse(req, { id: "P0", name, detail: `policy sequence ${seq} was revoked by the owner (through ${this.state.revokedThrough})` });
      if (seq < this.state.policySequence) return this.refuse(req, { id: "P0", name, detail: `policy sequence ${seq} was superseded by the owner's policy ${this.state.policySequence}` });
    }
    const r = await this.engine.evaluateTrade(req);
    if (r.approved) { this.state.nonces.push(req.nonce); this.keepReservations(); this.save(); }
    return { ...r, record: readFileSync(r.recordPath, "utf8"), engine: this.engineName };
  }

  /** The engine keeps one replay set for conversions and payments; an approved payment's nonce is made durable too. */
  evaluatePayment(req: any) { return this.serial(() => this.paymentNow(req)); }
  private async paymentNow(req: any) {
    if (!this.engine) throw new Error("co-signer not configured");
    if (req?.kind !== "owner-instructed" || typeof req.nonce !== "string" || !req.nonce.length) throw new Error("only owner-instructed payments are certified on the rail");
    const r = await this.engine.evaluate(req);
    if (r.approved) { this.state.nonces.push(req.nonce); this.keepReservations(); this.save(); }
    return { ...r, record: readFileSync(r.recordPath, "utf8"), engine: this.engineName };
  }
}

/**
 * The shared co-signer as the host sees it: one service, one scope per workspace. Each scope has its own key, its own
 * replay set and policy sequence, and its own vault configuration, so a certificate or a policy of one workspace
 * means nothing to another. A workspace receives `port(scope)`, the single-vault CosignerPort it always used.
 */
/** The one text the co-signer's self-test signs (EIP-191; R13 review fix F3). */
export const COSIGNER_SELF_TEST = "QED co-signer self-test: this signature authorises nothing.";

export interface CosignerHost {
  readonly isolation: "separate-process" | "in-process";
  address(scope: string): Promise<Address>;
  alive(): Promise<boolean>;
  configure(scope: string, cfg: CosignerConfig): Promise<void>;
  call(scope: string, op: "evaluateTrade" | "evaluatePayment" | "registerPolicy" | "revokePolicies" | "registerGrant" | "registerCaps" | "earnedCaps" | "authority" | "prepareRotation" | "commitRotation" | "selfTest", payload: any): Promise<any>;
  stop(): Promise<void>;
}

export function scopedPort(host: CosignerHost, scope: string): CosignerPort & { readonly pid: number | null; readonly scope: string } {
  return {
    scope,
    /** The operating-system process of a separate co-signer (null when it runs in the rail's process). */
    get pid() { return (host as { pid?: number | null }).pid ?? null; },
    isolation: host.isolation,
    address: () => host.address(scope),
    alive: () => host.alive(),
    configure: (cfg) => host.configure(scope, cfg),
    evaluateTrade: (req) => host.call(scope, "evaluateTrade", req),
    evaluatePayment: (req) => host.call(scope, "evaluatePayment", req),
    registerPolicy: (policy, policySig) => host.call(scope, "registerPolicy", { policy, policySig }),
    revokePolicies: (message, signature) => host.call(scope, "revokePolicies", { message, signature }),
    registerGrant: (message, signature) => host.call(scope, "registerGrant", { message, signature }),
    registerCaps: (message, signature, at) => host.call(scope, "registerCaps", { message, signature, at }),
    earnedCaps: (nowMs) => host.call(scope, "earnedCaps", { nowMs }),
    authority: () => host.call(scope, "authority", {}),
    prepareRotation: async () => (await host.call(scope, "prepareRotation", {})).address as Address,
    commitRotation: async (expected) => (await host.call(scope, "commitRotation", { expected })).address as Address,
    stop: async () => {}, // the host stops the shared service, never one workspace
  };
}

/** The scopes of one co-signer service, with their cores created on first use. Shared by both hosts. */
export class CosignerScopes {
  private readonly cores = new Map<string, CosignerCore>();
  private readonly file: ScopeStateFile;
  private readonly v: Vendored;
  private readonly keys: ScopedKeySource;
  constructor(v: Vendored, keys: ScopedKeySource, stateFile: string) {
    this.v = v;
    this.keys = keys;
    this.file = new ScopeStateFile(stateFile);
  }
  core(scope: string): CosignerCore {
    if (!SCOPE_RE.test(scope)) throw new Error("invalid co-signer scope");
    let c = this.cores.get(scope);
    if (!c) { c = new CosignerCore(this.v, (version) => this.keys(scope, version), this.file, scope); this.cores.set(scope, c); }
    return c;
  }
  async run(scope: string, op: string, p: any): Promise<any> {
    const c = this.core(scope);
    switch (op) {
      case "address": return { address: c.address };
      case "selfTest": return { address: c.address, signature: await c.selfTest() };
      case "configure": c.configure(p); return { address: c.address };
      case "evaluateTrade": return c.evaluateTrade(p);
      case "evaluatePayment": return c.evaluatePayment(p);
      case "registerPolicy": return c.registerPolicy(p.policy, p.policySig);
      case "revokePolicies": return c.revokePolicies(p.message, p.signature);
      case "registerGrant": return c.registerGrant(p.message, p.signature);
      case "registerCaps": return c.registerCaps(p.message, p.signature, p.at);
      case "earnedCaps": return c.capsView(Number(p.nowMs));
      case "authority": return c.authority();
      case "prepareRotation": return { address: c.prepareRotation() };
      case "commitRotation": return { address: c.commitRotation(p.expected) };
      default: throw new Error(`unknown operation ${op}`);
    }
  }
}

export class InProcessCosigner implements CosignerHost {
  readonly isolation = "in-process" as const;
  private readonly scopes: CosignerScopes;
  constructor(v: Vendored, keys: ScopedKeySource, stateFile: string) {
    this.scopes = new CosignerScopes(v, keys, stateFile);
  }
  async address(scope: string) { return this.scopes.core(scope).address; }
  async alive() { return true; }
  async configure(scope: string, cfg: CosignerConfig) { this.scopes.core(scope).configure(cfg); }
  call(scope: string, op: string, payload: any) { return this.scopes.run(scope, op, payload); }
  async stop() {}
}
