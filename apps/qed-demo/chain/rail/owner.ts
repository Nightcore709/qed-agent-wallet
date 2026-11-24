/**
 * Who may act as a workspace's owner, and how the rail obtains that authority (R7 D3, layer 3).
 *
 * OwnerAuthority is the one interface every owner action goes through. Two implementations exist:
 *
 *   ReleaseDevelopmentOwner  the release's development owner key, held by this process. ONLY for the baseline parity
 *                            tests (host mode "baseline-parity"); never for a workspace created through POST
 *                            /workspaces. Its approvals are the five-field statements of the backend (RISK-040).
 *   PasskeyAccountOwner      the workspace's QEDOwnerAccount (chain/accounts). Its signers are the members' P-256
 *                            passkeys. A proposal lists what the passkey must sign (`terms.toSign`): the account's
 *                            EIP-712 execute digest for owner transactions, and its ERC-1271 replay-safe hash for a
 *                            mandate or message. The approval carries the WebAuthn assertions; the rail checks them
 *                            ON CHAIN (a simulated `execute`, or `isValidSignature`), then relays the transaction
 *                            and pays its gas with a relayer key that is not a signer. The rail holds no key that can
 *                            satisfy the account.
 *
 * The owner-account build is chain/accounts' work. It is used only when that folder declares it ready (README.md or
 * HANDOFF.md), or when the host is started with ownerAccountBuild "unreviewed", which every view then says.
 */
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { decodeErrorResult, encodeFunctionData, getAddress, hashMessage, parseEventLogs, type Abi, type AbiParameter, type Address, type Hex, type LocalAccount, type PublicClient } from "viem";
import { isGuardedCall, type Guard } from "../accounts/webauthn.ts";
import { checkApproval } from "../terms.ts";
import type { Approval, ToSign } from "../types.ts";
import { CHAIN_DIR } from "./config.ts";
import { OwnerSigner, type ApprovalWindow, type OwnerAction } from "./keys.ts";
import { AssertionError, assertionsFor, encodeAssertions, type ContractAssertion } from "./webauthn.ts";

export const ACCOUNTS_DIR = join(CHAIN_DIR, "accounts");
export const ACCOUNT_ARTIFACT = join(ACCOUNTS_DIR, "out", "QEDOwnerAccount.sol", "QEDOwnerAccount.json");
/** The functions the rail calls on the account; the wiring test checks the build still has them. */
export const ACCOUNT_FUNCTIONS = ["execute", "executeDigest", "isValidSignature", "checkSignature", "replaySafeHash", "nonce", "threshold", "adminThreshold", "signerIds", "getSigner", "rpIdHash", "origin"] as const;
const ERC1271_MAGIC = "0x1626ba7e";

export const READY_FILE = join(ACCOUNTS_DIR, "READY.json");
export const READY_ARTIFACT = "out/QEDOwnerAccount.sol/QEDOwnerAccount.json";
export interface Readiness { declared: boolean; source: string | null; reason: string; artifactSha256: string | null; solc: string | null; date: string | null }
/** `sha256` is the SHA-256 of the artifact FILE, as READY.json states it; `bytecodeSha256` that of the creation code. */
export interface AccountArtifact { abi: Abi; bytecode: Hex; sha256: string; bytecodeSha256: string; solc: string | null; path: string; readiness: Readiness; build: "declared" | "unreviewed" }

/** Errors that refuse an owner action before anything is sent. */
export class OwnerAuthorityError extends Error {
  code: string;
  http: number;
  details: Record<string, unknown>;
  constructor(code: string, message: string, http = 409, details: Record<string, unknown> = {}) {
    super(message);
    this.name = "OwnerAuthorityError";
    this.code = code;
    this.http = http;
    this.details = details;
  }
}

/**
 * Does chain/accounts declare QEDOwnerAccount ready? Only through chain/accounts/READY.json (decision Q-B of
 * the R7 orchestrator, 22 Nov 2026): { "status": "ready", "artifact": "out/QEDOwnerAccount.sol/QEDOwnerAccount.json",
 * "artifactSha256": "<sha256 of that file>", "solc": "0.8.38", "date": "…" }, and the file's hash must match.
 */
export function accountReadiness(dir = ACCOUNTS_DIR): Readiness {
  const no = (reason: string): Readiness => ({ declared: false, source: null, reason, artifactSha256: null, solc: null, date: null });
  const p = join(dir, "READY.json");
  if (!existsSync(p)) return no("chain/accounts/READY.json does not exist");
  let r: Record<string, unknown>;
  try { r = JSON.parse(readFileSync(p, "utf8")); } catch { return no("chain/accounts/READY.json is not valid JSON"); }
  if (r.status !== "ready") return no(`chain/accounts/READY.json has status ${JSON.stringify(r.status)}, not "ready"`);
  if (r.artifact !== READY_ARTIFACT) return no(`chain/accounts/READY.json names ${JSON.stringify(r.artifact)}, not ${READY_ARTIFACT}`);
  const file = join(dir, READY_ARTIFACT);
  if (!existsSync(file)) return no(`${READY_ARTIFACT} does not exist`);
  const sha = createHash("sha256").update(readFileSync(file)).digest("hex");
  if (typeof r.artifactSha256 !== "string" || r.artifactSha256.toLowerCase() !== sha) return no(`the artifact's SHA-256 is ${sha}, but chain/accounts/READY.json states ${JSON.stringify(r.artifactSha256)}`);
  return { declared: true, source: "chain/accounts/READY.json", reason: `status ready; the artifact's SHA-256 ${sha} matches`, artifactSha256: sha, solc: typeof r.solc === "string" ? r.solc : null, date: typeof r.date === "string" ? r.date : null };
}

/** Loads the owner-account build, or says exactly why it may not be used. Reads chain/accounts; never writes there. */
export function loadAccountArtifact(build: "declared" | "unreviewed", path = ACCOUNT_ARTIFACT, dir = ACCOUNTS_DIR): AccountArtifact {
  const readiness = accountReadiness(dir);
  if (build === "declared" && !readiness.declared) throw new OwnerAuthorityError("owner_account_not_ready", `Workspaces are owned by a passkey account (QEDOwnerAccount, chain/accounts), and its build is not declared ready: ${readiness.reason}. No workspace was created. For tests only, QED_RAIL_OWNER_ACCOUNT_BUILD=unreviewed uses the current build, labelled as unreviewed in every view.`, 503);
  if (!existsSync(path)) throw new OwnerAuthorityError("owner_account_unavailable", "The owner-account build (chain/accounts/out/QEDOwnerAccount.sol/QEDOwnerAccount.json) does not exist. No workspace was created.", 503);
  let raw: Buffer, json: any;
  try { raw = readFileSync(path); json = JSON.parse(raw.toString("utf8")); } catch { throw new OwnerAuthorityError("owner_account_unavailable", "The owner-account build could not be read (it may be being rebuilt). No workspace was created; try again.", 503); }
  const bytecode = json?.bytecode?.object as Hex | undefined, abi = json?.abi as Abi | undefined;
  if (!abi || typeof bytecode !== "string" || !/^0x[0-9a-fA-F]{100,}$/.test(bytecode)) throw new OwnerAuthorityError("owner_account_unavailable", "The owner-account build has no ABI or bytecode. No workspace was created.", 503);
  const names = new Set(abi.filter((x) => x.type === "function").map((x) => (x as { name: string }).name));
  const missing = ACCOUNT_FUNCTIONS.filter((f) => !names.has(f));
  if (missing.length) throw new OwnerAuthorityError("owner_account_incompatible", `The owner-account build lacks ${missing.join(", ")}, which the rail calls. No workspace was created.`, 503);
  const sha256 = createHash("sha256").update(raw).digest("hex");
  // "declared" was checked against this very file above; re-check that it did not change in between.
  if (build === "declared" && sha256 !== readiness.artifactSha256) throw new OwnerAuthorityError("owner_account_not_ready", "The owner-account build changed while it was being read. No workspace was created; try again.", 503);
  return { abi, bytecode, sha256, bytecodeSha256: createHash("sha256").update(bytecode.toLowerCase()).digest("hex"), solc: json?.metadata?.compiler?.version ?? null, path, readiness, build };
}

/**
 * Whether an owner-account build has R13's containment: a sentinel that may freeze a member, and `protect`. Builds before
 * it (every workspace created earlier keeps the ABI it was created with) take eight constructor arguments and have
 * neither; they do not gain them (no upgrade path: the account is not upgradeable).
 */
export function accountTakesContainment(abi: Abi): boolean {
  return abi.some((x) => x.type === "function" && (x as { name: string }).name === "freeze") && abi.some((x) => x.type === "function" && (x as { name: string }).name === "protect");
}

/**
 * Whether an owner-account build has R13's owner options: a guardian that co-signs recoveries, and the optional time-lock
 * of the vaults' withdraw, ringFence, unpause and setGuardian. Such a build takes twelve constructor arguments (the
 * lockable list and the time-lock's starting state appended). Accounts built before it keep their bytecode and gain
 * neither.
 */
export function accountTakesOwnerOptions(abi: Abi): boolean {
  const fns = new Set(abi.filter((x) => x.type === "function").map((x) => (x as { name: string }).name));
  return ["setGuardian", "startCosignedRecovery", "setTimeLock", "timeLocked", "guardian", "lockableCalls"].every((f) => fns.has(f)) && accountTakesContainment(abi);
}

// ───────────────────────────── the interface ─────────────────────────────

/** What prepare() needs from the workspace: chain reads and the generic encoder of an owner action. */
export interface PrepareContext {
  chainId: number;
  /** Unix seconds after which the passkey's signature on an execute batch is void on-chain. */
  deadline: bigint;
  encodeAction: (a: OwnerAction) => Hex;
  mandateDigest: (mandate: Record<string, unknown>) => Promise<Hex>;
}

export interface OwnerAuthority {
  readonly kind: "release-development-owner" | "passkey-account";
  /** Where the owner's authority lives, in words; shown in every state view. */
  readonly custody: string;
  readonly address: Address;
  /** True when approvals must carry the owner's signatures (`approval.signatures`, one entry per `terms.toSign`). */
  readonly needsSignatures: boolean;
  /** What the owner must sign for these terms; [] when the authority signs itself (development owner). */
  prepare(terms: Record<string, unknown>, p: PrepareContext): Promise<ToSign[]>;
  /** Checks the approval's signatures against the chain without sending anything; throws OwnerAuthorityError. */
  verify(terms: Record<string, unknown>, approval: Approval): Promise<void>;
  signMessage(terms: { message: string; toSign?: ToSign[] }, approval: unknown, window: ApprovalWindow): Promise<{ signature: Hex; approval: Approval }>;
  signMandate(terms: { chainId: number; mandate: Record<string, unknown>; toSign?: ToSign[] }, approval: unknown, window: ApprovalWindow, sign: (owner: LocalAccount, chainId: number, mandate: any) => Promise<Hex>, toMandate: (fields: Record<string, unknown>) => unknown): Promise<{ signature: Hex; approval: Approval }>;
  /**
   * Sends `terms.actions[index]` with the owner's authority. For a passkey account the whole approved batch is ONE
   * `execute` (atomic, one nonce); asking for another index of the same terms returns that same transaction.
   */
  sendAction(terms: { actions: OwnerAction[]; toSign?: ToSign[] }, index: number, approval: unknown, window: ApprovalWindow, abi: Abi, chain: { send: (account: LocalAccount, to: Address, data: Hex) => Promise<any> }, decodeArgs?: (args: unknown[]) => unknown[]): Promise<{ tx: any; approval: Approval }>;
}

// ───────────────────────────── baseline parity: the release's development owner ─────────────────────────────

export class ReleaseDevelopmentOwner implements OwnerAuthority {
  readonly kind = "release-development-owner" as const;
  readonly custody = "rail process: the release's DEVELOPMENT owner key, derived from a public string (baseline parity mode only; RISK-040)";
  readonly needsSignatures = false;
  readonly address: Address;
  readonly #signer: OwnerSigner;
  constructor(signer: OwnerSigner) {
    this.#signer = signer;
    this.address = signer.address;
  }
  async prepare(): Promise<ToSign[]> { return []; }
  async verify(): Promise<void> {}
  signMessage(terms: { message: string }, approval: unknown, window: ApprovalWindow) { return this.#signer.signMessage(terms, approval, window); }
  signMandate(terms: { chainId: number; mandate: Record<string, unknown> }, approval: unknown, window: ApprovalWindow, sign: (o: LocalAccount, c: number, m: any) => Promise<Hex>, toMandate: (f: Record<string, unknown>) => unknown) { return this.#signer.signMandate(terms, approval, window, sign, toMandate); }
  sendAction(terms: { actions: OwnerAction[] }, index: number, approval: unknown, window: ApprovalWindow, abi: Abi, chain: { send: (account: LocalAccount, to: Address, data: Hex) => Promise<any> }, decodeArgs?: (args: unknown[]) => unknown[]) { return this.#signer.sendAction(terms, index, approval, window, abi, chain, decodeArgs); }
}

// ───────────────────────────── R7: the workspace's passkey account ─────────────────────────────

/** What the passkey authority needs from the workspace's chain: reads, the relayer key, and journaled sending. */
export interface AccountPort {
  pub: PublicClient;
  relayer: LocalAccount;
  /** Release ABIs, to decode the reason inside CallFailed. */
  releaseAbis: Abi[];
}

const execCalls = (entry: Extract<ToSign, { kind: "execute" }>) => entry.calls.map((c) => ({ target: getAddress(c.target), value: BigInt(c.value), data: c.data }));

export class PasskeyAccountOwner implements OwnerAuthority {
  readonly kind = "passkey-account" as const;
  readonly custody = "passkey owner account (QEDOwnerAccount): its signers are the members' passkeys; the service holds no key that can satisfy it and only relays";
  readonly needsSignatures = true;
  readonly address: Address;
  readonly #abi: Abi;
  readonly #port: AccountPort;
  /** The calls this account refuses to run at once (fixed at its deployment); they are scheduled instead. */
  readonly guards: Guard[];
  /** R13: the calls it also refuses at once while its time-lock is on (fixed at its deployment; none before R13). */
  readonly lockable: Guard[];
  /** One execute per approved batch: the transaction of each terms object already sent in this process. */
  readonly #sent = new WeakMap<object, any>();
  /** `abi` is the account ABI recorded when the workspace was created, so a later rebuild of chain/accounts changes nothing here. */
  constructor(address: Address, abi: Abi, port: AccountPort, guards: Guard[] = [], lockable: Guard[] = []) {
    this.address = getAddress(address);
    this.#abi = abi;
    this.#port = port;
    this.guards = guards;
    this.lockable = lockable;
  }

  /** Whether the account has R13's owner options (a guardian, the time-lock). */
  get hasOwnerOptions(): boolean { return accountTakesOwnerOptions(this.#abi); }
  /** Whether the time-lock is on now (false for an account built before R13). */
  async timeLockOn(): Promise<boolean> { return this.hasOwnerOptions ? ((await this.read("timeLocked")) as boolean) : false; }

  read(functionName: string, args: unknown[] = []): Promise<any> {
    return this.#port.pub.readContract({ address: this.address, abi: this.#abi, functionName, args } as never);
  }

  async prepare(terms: Record<string, unknown>, p: PrepareContext): Promise<ToSign[]> {
    const out: ToSign[] = [];
    const threshold = Number(await this.read("threshold"));
    const actions = (terms.actions as OwnerAction[] | undefined) ?? [];
    if (actions.length) {
      const nonce = (await this.read("nonce")) as bigint;
      const all = actions.map((a, i) => ({ target: getAddress(a.to), value: 0n, data: p.encodeAction(a), action: `${a.contract}.${a.function}`, i }));
      // Guarded calls never run through execute (GuardedCall): they go into one scheduleCalls, applied after the delay.
      // R13: so do the lockable calls while the account's time-lock is on.
      const locked = this.lockable.length > 0 && (await this.timeLockOn());
      const guarded = all.filter((c) => isGuardedCall({ target: c.target, value: c.value, data: c.data } as never, this.guards) || (locked && isGuardedCall({ target: c.target, value: c.value, data: c.data } as never, this.lockable)) || actions[c.i]?.schedule === true);
      const now = all.filter((c) => !guarded.includes(c));
      const calls = now.map((c) => ({ target: c.target, value: 0n, data: c.data, action: c.action }));
      if (guarded.length) calls.push({ target: this.address, value: 0n, data: encodeFunctionData({ abi: this.#abi, functionName: "scheduleCalls", args: [guarded.map((c) => ({ target: c.target, value: 0n, data: c.data }))] } as never), action: `QEDOwnerAccount.scheduleCalls(${guarded.map((c) => c.action).join(", ")})` });
      const bare = calls.map((c) => ({ target: c.target, value: c.value, data: c.data }));
      const selfCall = bare.some((c) => c.target === this.address);
      const digest = (await this.read("executeDigest", [bare, nonce, p.deadline])) as Hex;
      out.push({
        kind: "execute", account: this.address, chainId: p.chainId, nonce: nonce.toString(), deadline: p.deadline.toString(),
        calls: calls.map((c) => ({ target: c.target, value: "0", data: c.data, action: c.action })), digest,
        threshold: selfCall ? Number(await this.read("adminThreshold")) : threshold,
        ...(guarded.length ? { schedule: { calls: guarded.map((c) => ({ target: c.target, value: "0", data: c.data, action: c.action })), actions: guarded.map((c) => c.i), delaySeconds: String(await this.read("delay")) } } : {}),
        ...(locked ? { timeLocked: true } : {}),
        note: guarded.length ? `The passkey signs this EIP-712 digest of QEDOwnerAccount.execute(calls, nonce, deadline). The ${locked ? "guarded and time-locked" : "guarded"} calls in it are only scheduled: they run after the account's delay, during which any one member can cancel them, and then anyone may apply them. The rail relays and pays gas.` : "The passkey signs this EIP-712 digest of QEDOwnerAccount.execute(calls, nonce, deadline): exactly these calls, once, before the deadline. The rail relays it and pays gas.",
      });
    }
    if (terms.cancel && typeof terms.cancel === "object") {
      const changeId = (terms.cancel as { changeId: Hex }).changeId;
      out.push({ kind: "cancel", account: this.address, chainId: p.chainId, changeId, digest: (await this.read("cancelDigest", [changeId])) as Hex, threshold: 1, note: "One member's passkey signs the account's cancel digest for this change; the account then drops it (QEDOwnerAccount.cancel)." });
    }
    if (terms.mandate && typeof terms.mandate === "object") {
      const hash = await p.mandateDigest(terms.mandate as Record<string, unknown>);
      out.push({ kind: "erc1271", account: this.address, chainId: p.chainId, purpose: "mandate", hash, digest: (await this.read("replaySafeHash", [hash])) as Hex, threshold, note: "The passkey signs the account's replay-safe hash of the vault's EIP-712 mandate digest. The vault verifies it with ERC-1271 (QEDVault: SignatureChecker.isValidSignatureNow)." });
    }
    if (typeof terms.message === "string" && terms.message.length) {
      const hash = hashMessage(terms.message);
      out.push({ kind: "erc1271", account: this.address, chainId: p.chainId, purpose: "message", hash, digest: (await this.read("replaySafeHash", [hash])) as Hex, threshold, note: "The passkey signs the account's replay-safe hash of the EIP-191 hash of `message`." });
    }
    // A hash another contract will check with ERC-1271 (the proof escrow's EIP-712 digest of a quote this account offers).
    const typed = terms.erc1271 as { purpose?: unknown; hash?: unknown } | undefined;
    if (typed && typed.purpose === "quote" && typeof typed.hash === "string" && /^0x[0-9a-fA-F]{64}$/.test(typed.hash)) {
      const hash = typed.hash as Hex;
      out.push({ kind: "erc1271", account: this.address, chainId: p.chainId, purpose: "quote", hash, digest: (await this.read("replaySafeHash", [hash])) as Hex, threshold, note: "The passkey signs the account's replay-safe hash of the proof escrow's EIP-712 digest of this quote. The escrow checks it with ERC-1271 (SignatureChecker.isValidSignatureNow) when the client funds the job." });
    }
    return out;
  }

  /** The approval's signature entry for toSign[i], as contract assertions; refuses a missing or mismatched entry. */
  #assertions(terms: { toSign?: ToSign[] }, approval: Approval, i: number): ContractAssertion[] {
    const entry = terms.toSign?.[i];
    if (!entry) throw new OwnerAuthorityError("approval_signature_missing", "These terms ask for no owner signature at that position.", 422);
    const sig = approval.signatures?.[i];
    if (sig === undefined) throw new OwnerAuthorityError("approval_signature_missing", `The approval carries no passkey signature for item ${i} of toSign (${entry.kind}${entry.kind === "erc1271" ? `, ${entry.purpose}` : ""}). Nothing was sent.`, 422);
    try {
      return assertionsFor(sig, entry.digest);
    } catch (e) {
      if (e instanceof AssertionError) throw new OwnerAuthorityError(e.code, e.message, e.code === "approval_signature_mismatch" ? 409 : 422);
      throw e;
    }
  }

  /** Decodes a revert of the account, and inside CallFailed the release contract's own error. */
  #explain(e: unknown): { name: string; args: unknown[]; inner?: { name: string; args: unknown[] } } {
    let data: Hex | undefined;
    for (let x: any = e; x && !data; x = x.cause) if (typeof x?.data === "string" && x.data.startsWith("0x")) data = x.data;
    if (!data || data === "0x") return { name: "UnknownRevert", args: [String((e as Error)?.message ?? e).split("\n")[0].slice(0, 200)] };
    try {
      const d = decodeErrorResult({ abi: this.#abi, data });
      const args = [...((d.args ?? []) as unknown[])];
      if (d.errorName === "CallFailed") {
        const reason = args[1] as Hex;
        // a call to the account itself (addSigner, removeSigners, setThresholds) fails with the account's own error
        for (const abi of [this.#abi, ...this.#port.releaseAbis]) {
          try { const r = decodeErrorResult({ abi, data: reason }); return { name: "CallFailed", args, inner: { name: r.errorName, args: [...((r.args ?? []) as unknown[])] } }; } catch { /* next */ }
        }
        return { name: "CallFailed", args, inner: { name: "UndecodedRevert", args: [reason] } };
      }
      return { name: d.errorName, args };
    } catch {
      for (const abi of this.#port.releaseAbis) {
        try { const r = decodeErrorResult({ abi, data }); return { name: r.errorName, args: [...((r.args ?? []) as unknown[])] }; } catch { /* next */ }
      }
      return { name: "UndecodedRevert", args: [data] };
    }
  }

  static readonly APPROVAL_ERRORS = new Set(["NotEnoughApprovals", "InvalidAssertion", "NotAMember", "AssertionsNotStrictlyIncreasing"]);

  /** Simulates execute; returns null when it would succeed, or the decoded reason. */
  async #simulate(entry: Extract<ToSign, { kind: "execute" }>, assertions: ContractAssertion[]) {
    const data = encodeFunctionData({ abi: this.#abi, functionName: "execute", args: [execCalls(entry), BigInt(entry.nonce), BigInt(entry.deadline), assertions] } as never);
    try {
      await this.#port.pub.call({ account: this.#port.relayer.address, to: this.address, data, blockTag: "pending" } as never);
      return { data, error: null };
    } catch (e) {
      return { data, error: this.#explain(e) };
    }
  }
  #refuse(entry: ToSign, err: { name: string; args: unknown[] }): never {
    const args = err.args.map((x) => String(x));
    if (err.name === "BadNonce") throw new OwnerAuthorityError("proposal_stale", `Another owner action used this account's signature slot (nonce ${args[1] ?? "?"}) after these terms were prepared for nonce ${args[0] ?? "?"}. Nothing was sent; prepare the action again.`, 409, { error: err.name, args });
    if (err.name === "NothingPending") throw new OwnerAuthorityError("change_not_pending", "The owner account holds no such pending change (it was applied or cancelled). Nothing was sent.", 409, { error: err.name, args });
    if (err.name === "Expired") throw new OwnerAuthorityError("approval_signature_expired", `The passkey signature's deadline ${args[0]} has passed (chain time ${args[1]}). Nothing was sent; prepare the action again.`, 409, { error: err.name, args });
    if (err.name === "CannotCancelOwnRemoval") throw new OwnerAuthorityError("cannot_cancel_own_removal", "A passkey cannot cancel a removal that removes it: another member's passkey must cancel it. Nothing was sent.", 409, { error: err.name, args });
    // R13: a call that became time-locked after these terms were prepared, and a frozen passkey against a co-signed recovery
    if (err.name === "GuardedCall") throw new OwnerAuthorityError("call_time_locked", "The owner account refuses this call at once now (its time-lock was turned on after these terms were prepared): prepare the action again and it will be scheduled behind the account's delay. Nothing was sent.", 409, { error: err.name, args });
    if (err.name === "FrozenSigner" && entry.kind === "cancel") throw new OwnerAuthorityError("frozen_cannot_cancel", "This passkey is frozen on the chain, and a frozen passkey cannot cancel a recovery the guardian co-signed. Another member's passkey that is not frozen can. Nothing was sent.", 409, { error: err.name, args });
    throw new OwnerAuthorityError("approval_signature_invalid", `The owner account refused the passkey signature${entry.kind === "erc1271" ? ` for the ${entry.purpose}` : ""}: ${err.name}(${args.join(", ")}). Nothing was sent.`, 409, { error: err.name, args });
  }

  /** Simulates and relays QEDOwnerAccount.cancel with the approval's one assertion over the cancel digest. */
  async sendCancel(terms: { toSign?: ToSign[] }, approval: unknown, window: ApprovalWindow, chain: { send: (account: LocalAccount, to: Address, data: Hex) => Promise<any> }) {
    const a = checkApproval(approval, terms, { ...window, signatures: "required" });
    const { i, entry } = this.#entry(terms, "cancel");
    const assertions = this.#assertions(terms, a, i);
    if (assertions.length !== 1) throw new OwnerAuthorityError("approval_signature_malformed", "A cancellation carries exactly one member's assertion.", 422);
    const data = encodeFunctionData({ abi: this.#abi, functionName: "cancel", args: [entry.changeId, assertions[0]] } as never);
    try { await this.#port.pub.call({ account: this.#port.relayer.address, to: this.address, data, blockTag: "pending" } as never); } catch (e) { this.#refuse(entry, this.#explain(e)); }
    return { tx: await chain.send(this.#port.relayer, this.address, data), approval: a };
  }
  /** Relays QEDOwnerAccount.applyCalls for a scheduled change; anyone may, once its delay has passed. Needs no approval. */
  async sendApply(changeId: Hex, calls: { target: Address; value: string; data: Hex }[], chain: { send: (account: LocalAccount, to: Address, data: Hex) => Promise<any> }) {
    const data = encodeFunctionData({ abi: this.#abi, functionName: "applyCalls", args: [changeId, calls.map((c) => ({ target: getAddress(c.target), value: BigInt(c.value), data: c.data }))] } as never);
    try { await this.#port.pub.call({ account: this.#port.relayer.address, to: this.address, data, blockTag: "pending" } as never); } catch (e) {
      const err = this.#explain(e), args = err.args.map(String);
      if (err.name === "NotReady") throw new OwnerAuthorityError("change_not_ready", `This change can be applied from ${new Date(Number(args[1]) * 1000).toISOString()}, not yet. Nothing was sent.`, 409, { error: err.name, args });
      if (err.name === "NothingPending") throw new OwnerAuthorityError("change_not_pending", "The owner account holds no such pending change (it was applied or cancelled). Nothing was sent.", 409, { error: err.name, args });
      if (err.name === "CallFailed" && err.inner) throw new OwnerAuthorityError("preflight_reverted", `A scheduled call would revert: ${err.inner.name}(${err.inner.args.map(String).join(", ")}). Nothing was sent; it stays pending.`, 409, { error: err.inner.name });
      throw new OwnerAuthorityError("preflight_reverted", `The owner account refused to apply this change: ${err.name}(${args.join(", ")}). Nothing was sent.`, 409, { error: err.name, args });
    }
    return chain.send(this.#port.relayer, this.address, data);
  }
  /** The account's ABI as recorded when the workspace was created. */
  get abi(): Abi { return this.#abi; }

  /** Simulates a call to the account from the relayer; null when it would succeed, or the decoded reason. */
  async preflight(data: Hex): Promise<{ name: string; args: unknown[]; inner?: { name: string; args: unknown[] } } | null> {
    try { await this.#port.pub.call({ account: this.#port.relayer.address, to: this.address, data, blockTag: "pending" } as never); return null; } catch (e) { return this.#explain(e); }
  }

  /**
   * Relays QEDOwnerAccount.applyChange for a scheduled change of the account itself (a removal of signers, lower
   * thresholds or shorter delays); anyone may, once its delay has passed. The account re-checks everything.
   */
  async sendApplyChange(changeId: Hex, chain: { send: (account: LocalAccount, to: Address, data: Hex) => Promise<any> }) {
    const data = encodeFunctionData({ abi: this.#abi, functionName: "applyChange", args: [changeId] } as never);
    const err = await this.preflight(data);
    if (err) {
      const args = err.args.map(String);
      if (err.name === "NotReady") throw new OwnerAuthorityError("change_not_ready", `This change can be applied from ${new Date(Number(args[1]) * 1000).toISOString()}, not yet. Nothing was sent.`, 409, { error: err.name, args });
      if (err.name === "NothingPending") throw new OwnerAuthorityError("change_not_pending", "The owner account holds no such pending change (it was applied or cancelled). Nothing was sent.", 409, { error: err.name, args });
      if (err.name === "ChangeStale") throw new OwnerAuthorityError("change_stale", "The account's signers or thresholds changed since this was scheduled, so the account refuses to apply it. Nothing was sent; schedule it again if it is still wanted.", 409, { error: err.name, args });
      if (err.name === "InvalidThresholds") throw new OwnerAuthorityError("change_breaks_quorum", `Applying this now would leave fewer signers than the thresholds need (threshold ${args[0]}, admin threshold ${args[1]}, members ${args[2]}). Nothing was sent; it stays pending.`, 409, { error: err.name, args });
      throw new OwnerAuthorityError("preflight_reverted", `The owner account refused to apply this change: ${err.name}(${args.join(", ")}). Nothing was sent.`, 409, { error: err.name, args });
    }
    return chain.send(this.#port.relayer, this.address, data);
  }
  /** Relays QEDOwnerAccount.finishRecovery; anyone may, once the recovery delay has passed and no member cancelled it. */
  async sendFinishRecovery(recoveryId: Hex, chain: { send: (account: LocalAccount, to: Address, data: Hex) => Promise<any> }) {
    const data = encodeFunctionData({ abi: this.#abi, functionName: "finishRecovery", args: [recoveryId] } as never);
    const err = await this.preflight(data);
    if (err) {
      const args = err.args.map(String);
      if (err.name === "NotReady") throw new OwnerAuthorityError("change_not_ready", `This recovery can be finished from ${new Date(Number(args[1]) * 1000).toISOString()}, not yet. Nothing was sent.`, 409, { error: err.name, args });
      if (err.name === "NothingPending") throw new OwnerAuthorityError("change_not_pending", "The owner account holds no such pending recovery (it was finished or cancelled). Nothing was sent.", 409, { error: err.name, args });
      // R13 review fixes: the owner's rule for co-signed recoveries, and a recovery started before the guardian took effect
      if (err.name === "NoUnfrozenMember") throw new OwnerAuthorityError("recovery_held", "Every passkey that signs for this account is frozen, and the account's sentinel (QED's key) did not stay unchanged for this co-signed recovery's whole wait, so nobody independent could have stopped it throughout: it does not finish while the passkeys stay frozen. Nothing was sent.", 409, { error: err.name, args });
      if (err.name === "GuardianRequired") throw new OwnerAuthorityError("recovery_needs_guardian", "This recovery started before the account's guardian took effect, without its co-signature: it does not finish while a guardian is set. A member can cancel it. Nothing was sent.", 409, { error: err.name, args });
      throw new OwnerAuthorityError("preflight_reverted", `The owner account refused to finish this recovery: ${err.name}(${args.join(", ")}). Nothing was sent.`, 409, { error: err.name, args });
    }
    return chain.send(this.#port.relayer, this.address, data);
  }
  /** The account's own view of a recovery: pending while readyAt > 0. */
  async recovery(recoveryId: Hex): Promise<{ readyAt: number; recoverySignerId: Hex; newX: bigint; newY: bigint }> {
    const r = (await this.read("getRecovery", [recoveryId])) as { recoverySignerId: Hex; newX: bigint; newY: bigint; readyAt: bigint };
    return { readyAt: Number(r.readyAt), recoverySignerId: r.recoverySignerId, newX: r.newX, newY: r.newY };
  }
  /** The account's events in one transaction's receipt (ChangeScheduled, SignerAdded, RecoveryStarted, …). */
  async eventsIn(txHash: Hex, eventName: string): Promise<{ args: any }[]> {
    const r = await this.#port.pub.getTransactionReceipt({ hash: txHash });
    const ev = parseEventLogs({ abi: this.#abi, logs: r.logs, eventName } as never) as unknown as { address: Address; args: any }[];
    return ev.filter((x) => getAddress(x.address) === this.address);
  }

  /** The change a transaction scheduled, read from the account's CallsScheduled event in its receipt. */
  async scheduledIn(txHash: Hex): Promise<{ changeId: Hex; readyAt: number } | null> {
    const r = await this.#port.pub.getTransactionReceipt({ hash: txHash });
    const ev = parseEventLogs({ abi: this.#abi, logs: r.logs, eventName: "CallsScheduled" } as never) as unknown as { address: Address; args: { changeId: Hex; readyAt: bigint } }[];
    const mine = ev.find((x) => getAddress(x.address) === this.address);
    return mine ? { changeId: mine.args.changeId, readyAt: Number(mine.args.readyAt) } : null;
  }
  /** The account's own view of a change: pending (readyAt > 0) or not. */
  async change(changeId: Hex): Promise<{ readyAt: number }> {
    const c = (await this.read("getChange", [changeId])) as { readyAt: bigint };
    return { readyAt: Number(c.readyAt) };
  }

  async verify(terms: Record<string, unknown>, approval: Approval): Promise<void> {
    const toSign = (terms.toSign as ToSign[] | undefined) ?? [];
    if (!Array.isArray(approval.signatures) || approval.signatures.length !== toSign.length) throw new OwnerAuthorityError("approval_signature_missing", `These terms need ${toSign.length} passkey signature${toSign.length === 1 ? "" : "s"} (approval.signatures, one per toSign item, in order); the approval carries ${Array.isArray(approval.signatures) ? approval.signatures.length : "none"}. Nothing was sent.`, 422);
    for (let i = 0; i < toSign.length; i++) {
      const entry = toSign[i], assertions = this.#assertions(terms, approval, i);
      if (entry.kind === "execute") {
        const r = await this.#simulate(entry, assertions);
        // CallFailed means the signatures passed and a called contract refused: that is the action's outcome, which
        // the job reports in its own words (for example a withdrawal above the free balance), not an approval fault.
        if (r.error && r.error.name !== "CallFailed") this.#refuse(entry, r.error);
      } else if (entry.kind === "cancel") {
        if (assertions.length !== 1) throw new OwnerAuthorityError("approval_signature_malformed", "A cancellation carries exactly one member's assertion.", 422);
        const data = encodeFunctionData({ abi: this.#abi, functionName: "cancel", args: [entry.changeId, assertions[0]] } as never);
        try { await this.#port.pub.call({ account: this.#port.relayer.address, to: this.address, data, blockTag: "pending" } as never); } catch (e) { this.#refuse(entry, this.#explain(e)); }
      } else await this.#erc1271(entry, assertions);
    }
  }

  async #erc1271(entry: Extract<ToSign, { kind: "erc1271" }>, assertions: ContractAssertion[]): Promise<Hex> {
    const signature = encodeAssertions(assertions);
    const magic = (await this.read("isValidSignature", [entry.hash, signature])) as Hex;
    if (magic.toLowerCase() === ERC1271_MAGIC) return signature;
    try { await this.read("checkSignature", [entry.hash, signature]); } catch (e) { this.#refuse(entry, this.#explain(e)); }
    throw new OwnerAuthorityError("approval_signature_invalid", "The owner account did not accept the passkey signature (ERC-1271). Nothing was signed or sent.", 409);
  }
  #entry<K extends ToSign["kind"]>(terms: { toSign?: ToSign[] }, kind: K, purpose?: string): { i: number; entry: Extract<ToSign, { kind: K }> } {
    const i = (terms.toSign ?? []).findIndex((t) => t.kind === kind && (purpose === undefined || (t as { purpose?: string }).purpose === purpose));
    if (i < 0) throw new OwnerAuthorityError("approval_signature_missing", `These terms carry no ${kind}${purpose ? ` (${purpose})` : ""} item to sign. Nothing was sent.`, 422);
    return { i, entry: terms.toSign![i] as Extract<ToSign, { kind: K }> };
  }

  async signMessage(terms: { message: string; toSign?: ToSign[] }, approval: unknown, window: ApprovalWindow) {
    const a = checkApproval(approval, terms, { ...window, signatures: "required" });
    const { i, entry } = this.#entry(terms, "erc1271", "message");
    if (entry.hash !== hashMessage(terms.message)) throw new OwnerAuthorityError("approval_terms_mismatch", "The message to sign does not match its hash in the terms. Nothing was signed.", 409);
    return { signature: await this.#erc1271(entry, this.#assertions(terms, a, i)), approval: a };
  }
  /** The ERC-1271 signature over `terms.erc1271.hash` (a quote), checked by the account on chain before it is returned. */
  async signHash(terms: { erc1271?: { purpose: string; hash: Hex }; toSign?: ToSign[] }, approval: unknown, window: ApprovalWindow) {
    const a = checkApproval(approval, terms, { ...window, signatures: "required" });
    const purpose = terms.erc1271?.purpose === "quote" ? "quote" : "";
    const { i, entry } = this.#entry(terms, "erc1271", purpose);
    if (entry.hash.toLowerCase() !== String(terms.erc1271?.hash).toLowerCase()) throw new OwnerAuthorityError("approval_terms_mismatch", "The hash to sign does not match the terms. Nothing was signed.", 409);
    return { signature: await this.#erc1271(entry, this.#assertions(terms, a, i)), approval: a };
  }
  async signMandate(terms: { chainId: number; mandate: Record<string, unknown>; toSign?: ToSign[] }, approval: unknown, window: ApprovalWindow) {
    const a = checkApproval(approval, terms, { ...window, signatures: "required" });
    const { i, entry } = this.#entry(terms, "erc1271", "mandate");
    return { signature: await this.#erc1271(entry, this.#assertions(terms, a, i)), approval: a };
  }
  async sendAction(terms: { actions: OwnerAction[]; toSign?: ToSign[] }, index: number, approval: unknown, window: ApprovalWindow, _abi: Abi, chain: { send: (account: LocalAccount, to: Address, data: Hex) => Promise<any> }) {
    const a = checkApproval(approval, terms, { ...window, signatures: "required" });
    if (!terms.actions?.[index]) throw new OwnerAuthorityError("approval_terms_mismatch", "The approved terms contain no such action.", 409);
    const done = this.#sent.get(terms);
    if (done) return { tx: done, approval: a };
    const { i, entry } = this.#entry(terms, "execute");
    // The calls are the approved ones: the digest the passkey signed covers exactly these targets and calldata (the
    // immediate actions, then one scheduleCalls with the guarded ones); termsHash covers both lists.
    const scheduledN = entry.schedule?.calls.length ?? 0;
    if (entry.calls.length !== terms.actions.length - scheduledN + (scheduledN ? 1 : 0)) throw new OwnerAuthorityError("approval_terms_mismatch", "The batch to sign does not match the approved actions. Nothing was sent.", 409);
    const assertions = this.#assertions(terms, a, i);
    const sim = await this.#simulate(entry, assertions);
    if (sim.error) {
      if (sim.error.name === "CallFailed" && sim.error.inner) throw new OwnerAuthorityError("preflight_reverted", `The contract refused this owner action before it was broadcast: ${sim.error.inner.name}(${sim.error.inner.args.map(String).join(", ")}). Nothing was sent.`, 409, { error: sim.error.inner.name, args: sim.error.inner.args.map(String) });
      this.#refuse(entry, sim.error);
    }
    const tx = await chain.send(this.#port.relayer, this.address, sim.data);
    this.#sent.set(terms, tx);
    return { tx, approval: a };
  }
}

// ───────────────────────────── encoding an owner action from its terms ─────────────────────────────

/** Turns JSON terms into ABI values: decimal strings into bigints for integer types, recursively through tuples and arrays. */
export function coerceArgs(inputs: readonly AbiParameter[], args: unknown[]): unknown[] {
  const one = (p: AbiParameter, v: unknown): unknown => {
    const arr = /^(.*)\[(\d*)\]$/.exec(p.type);
    if (arr) return (v as unknown[]).map((x) => one({ ...p, type: arr[1] } as AbiParameter, x));
    if (p.type === "tuple") {
      const comps = (p as { components: readonly AbiParameter[] }).components;
      const o = v as Record<string, unknown>;
      return Object.fromEntries(comps.map((c) => [c.name!, one(c, o[c.name!])]));
    }
    if (/^u?int\d*$/.test(p.type)) return BigInt(v as string | number | bigint);
    return v;
  };
  return inputs.map((p, i) => one(p, args[i]));
}

export function encodeOwnerAction(abiFor: (contractLabel: string) => Abi, a: OwnerAction): Hex {
  const abi = abiFor(a.contract);
  const fn = abi.find((x) => x.type === "function" && (x as { name: string }).name === a.function && (x as { inputs: readonly AbiParameter[] }).inputs.length === a.args.length) as { inputs: readonly AbiParameter[] } | undefined;
  if (!fn) throw new Error(`${a.contract} has no function ${a.function} taking ${a.args.length} arguments`);
  return encodeFunctionData({ abi, functionName: a.function, args: coerceArgs(fn.inputs, a.args) } as never);
}
