/**
 * RailHost: one shared local chain and everything shared on it (R7 D1, D3, D4).
 *
 * The host supervises ONE Anvil (the shared chain), persists its state after every operation, keeps its clock on the
 * wall clock by moving it forward to wall time only (never a jump ahead, never a reset), runs the shared co-signer
 * service, and holds the workspaces. Every write to the shared chain goes through one writer.
 *
 *   multi-tenant (default)  the shared test market is deployed once (deploy.ts → deployMarket). Each workspace is
 *                           created through POST /workspaces (createWorkspace): its own passkey owner account, tINR
 *                           treasury vault, tUSD reserve vault, execution module and treasury policy, all owned by the
 *                           account from their first block, its own keys (HKDF from this installation's master
 *                           secret) and its own store file. The service holds no key that can act as an owner.
 *   baseline-parity         the release's sandbox, deployed exactly as the release deploys it, and one implicit
 *                           workspace "baseline" whose owner is the release's DEVELOPMENT key, held by this process.
 *                           Only for the baseline parity tests; POST /workspaces is refused.
 *
 * Hazards never touch the shared chain: the Security Lab's attacks and every scenario run on an ephemeral Anvil of
 * their own (ephemeral()), scripted economies on theirs (economies.ts); only their records stay, in the workspace that
 * ran them.
 */
import { createHash, createPublicKey, randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { getAddress, getContractAddress, parseEther, toFunctionSelector, toHex, type Address, type Hex, type LocalAccount } from "viem";
import { hashTerms } from "../terms.ts";
import { NETWORK_LABEL, NETWORK_LABEL_MULTI, type ClockReading, type CreateWorkspaceRequest, type Health, type QuotaClass, type QuotaView, type WorkspaceView } from "../types.ts";
import { Anvil } from "./anvil.ts";
import { quickReceipts } from "./chain-socket.ts";
import { ClockSkewError, GapDetector, alignNextBlock, anchor, reading, type Gap } from "./clock.ts";
import { BASELINE_WORKSPACE, CHAIN_ID, RELEASE_ID, defaultConfig, type RailConfig } from "./config.ts";
import { COSIGNER_SELF_TEST, InProcessCosigner, SCOPE_RE, scopedPort, type CosignerConfig, type CosignerHost } from "./cosigner.ts";
import { cosignerRecordsDir } from "./cosigner-env.ts";
import { startReadOnlyDoor, type ReadOnlyDoor } from "./chain-socket.ts";
import type { D7Config, Reference } from "./authority-ledger.ts";
import { INR_DECIMALS, INR_VENUES, deployMarket, deployReleaseSandbox, emptyCurrencyMarket, ensureCurrencyMarket, tokenOf, type Addresses, type CurrencyMarket, type MarketAddresses } from "./deploy.ts";
import { AssetSetError, CHAIN_TOKENS, DEFAULT_ASSET_SET, assetSetDigest, assetSetDocument, checkAssetSet, fromInr, isDefaultSet, poolKey, referenceBandOf, venuePlan, type AssetSet } from "../../shared/chain-assets.ts";
import { deviationBps, keeperTrades, type KeeperPool } from "./keeper.ts";
import { OwnerSigner, derivedAccount, devAccount, loadOrCreateMasterSecret, masterCheckOf } from "./keys.ts";
import { anySealed, lockFolder, sealingOn } from "./sealed-at-rest.ts";
import { accountTakesContainment, accountTakesOwnerOptions, OwnerAuthorityError, PasskeyAccountOwner, ReleaseDevelopmentOwner, loadAccountArtifact } from "./owner.ts";
import { RailError, RailService, publicError } from "./service.ts";
import { Store, parse } from "./store.ts";
import { loadVendored, verifyVendoredTree, type Vendored } from "./vendored.ts";
import { MAX_ASSERTIONS, signerIdOf, verifyAssertionOffChain } from "./webauthn.ts";
import { releaseGuards, releaseLockable, releaseProtective } from "../accounts/webauthn.ts";
import { loadDenyList, type DenyList } from "./denylist.ts";
import { installAdmin } from "./admin.ts";
import { installEconomies } from "./economies.ts";
import { installPolicy } from "./policy.ts";
import { installScenarios } from "./scenarios.ts";
import { installTreasury } from "./treasury.ts";
import { installLab } from "./lab.ts";
import { installAuthority } from "./authority-ops.ts";
import { installSigners } from "./signers.ts";
import { installEscrow } from "./escrow.ts";
import { ensureBountyBoard, installBounties, type BountyBoardRecord } from "./bounties.ts";
import { ensureDisputeEscrow, type DisputeEscrow } from "./disputes.ts";
import { installMovements } from "./movements.ts";
import { installOwnership } from "./ownership.ts";

export type Rail = RailService & {
  policy: ReturnType<typeof installPolicy>;
  scenarios: ReturnType<typeof installScenarios>;
  economies: ReturnType<typeof installEconomies>;
  treasury: ReturnType<typeof installTreasury>;
  signers: ReturnType<typeof installSigners>;
  escrow: ReturnType<typeof installEscrow>;
  bounties: ReturnType<typeof installBounties>;
  /** What moved in and out of the wallet, from the chain's logs, for the wallet's books (rail/movements.ts). */
  movements: ReturnType<typeof installMovements>;
  /** Ownership transfer and the creditor's release or assignment of a claim (rail/ownership.ts, R13 S5). */
  ownership: ReturnType<typeof installOwnership>;
};

/** A workspace with every operation installed: the core service plus policy, scenarios, economies, treasury and incident response. */
export function composeWorkspace(ws: RailService): Rail {
  const rail = ws as Rail;
  rail.policy = installPolicy(rail);
  rail.scenarios = installScenarios(rail);
  rail.economies = installEconomies(rail, rail.scenarios.zkAvailable);
  rail.treasury = installTreasury(rail);
  installAdmin(rail);
  installLab(rail);
  installAuthority(rail);
  rail.signers = installSigners(rail);
  rail.escrow = installEscrow(rail);
  rail.bounties = installBounties(rail);
  rail.movements = installMovements(rail);
  rail.ownership = installOwnership(rail);
  return rail;
}

/** One ephemeral chain: its own Anvil on its own port, destroyed when the run ends. */
export interface EphemeralChain { anvil: Anvil; c: any; port: number; url: string; dir: string }

const QUOTA_COUNTS: Record<QuotaClass | "workspaces", string> = { proposals: "proposals prepared", operations: "operations accepted", economies: "scripted economies started", workspaces: "workspaces created" };
const DEFAULT_ORIGIN = "http://localhost:5175";
const RESERVED = new Set(["baseline", "health", "workspaces", "quota", "host", "admin"]);
const FEES = { maxFeePerGas: 20_000_000n, maxPriorityFeePerGas: 10_000_000n };


export class RailHost {
  readonly cfg: RailConfig;
  status: "starting" | "ready" | "failed" | "stopped" = "stopped";
  error: string | null = null;
  startedAt = new Date().toISOString();
  restoredFromState = false;
  vendoredOk: boolean | null = null;
  /** dataDir/rail.db: host meta, clock events, the workspace registry and the host's budget. In baseline-parity mode it is also the baseline workspace's store, as it always was. */
  store!: Store;
  v!: Vendored;
  c!: any;
  anvil!: Anvil;
  brain!: RailService["brain"];
  cosigner!: CosignerHost;
  genesisId: string | null = null;
  market: MarketAddresses | null = null;
  /** Money-model S5: the test tokens and pools deployed for the currency sets workspaces chose (deploy.ts ensureCurrencyMarket). */
  currencyMarket: CurrencyMarket = emptyCurrencyMarket();
  baselineAddresses: Addresses | null = null;
  /** The local refutation bounties (rail/bounties.ts): the board and its bounties, or why there are none. */
  bountyBoard: BountyBoardRecord | null = null;
  bountyStatus: { state: "off" | "ready" | "unavailable"; reason?: string } = { state: "off", reason: "Not started." };
  /** The review and dispute step in front of the proof escrow (rail/disputes.ts), or why there is none. */
  disputes: DisputeEscrow | null = null;
  disputeStatus: { state: "off" | "ready" | "unavailable"; reason?: string } = { state: "off", reason: "Not started." };
  #abis: unknown[] | null = null;
  /** The ABIs an owner account decodes a refused call with: the release's, and the dispute escrow's once deployed (one shared list). */
  private decodeAbis(): any[] { return (this.#abis ??= [...this.v.chain.ALL_ABIS]); }
  /** The baseline workspace (baseline-parity mode), created by createRail before start. */
  baseline: Rail | null = null;
  readonly workspaces = new Map<string, Rail>();
  economy: { jobId: string; workspaceId: string; child: import("node:child_process").ChildProcess | null } | null = null;
  #master: Buffer | null = null;
  /** Releases the secrets' folder lock (sealed-at-rest.ts), when it was taken. */
  #unlockSecrets: (() => void) | null = null;
  #hostKeys: { deployer: LocalAccount; cloudco: LocalAccount; denied: LocalAccount; keeper: LocalAccount } | null = null;
  /** The co-signers' deny list, with its source and date (denylist.ts, F-033 / P7); read when the service starts. */
  denyList: DenyList | null = null;
  #writer: Promise<unknown> = Promise.resolve();
  writerQueued = 0;
  #heartbeat: NodeJS.Timeout | null = null;
  #gaps!: GapDetector;
  #restarting = false;
  #ephemeralActive = 0;
  #ephemeralWaiting: (() => void)[] = [];

  constructor(cfg: Partial<RailConfig> = {}) {
    this.cfg = defaultConfig(cfg);
  }
  get mode() { return this.cfg.mode; }
  get networkLabel() { return this.cfg.mode === "baseline-parity" ? NETWORK_LABEL : NETWORK_LABEL_MULTI; }
  now = () => this.cfg.wallClock();
  iso = () => new Date(this.cfg.wallClock()).toISOString();
  get pub(): any { return this.c.pub; }
  rpc = (method: string, params: unknown[] = []) => this.anvil.rpc(method, params);
  latestTs = async () => Number((await this.pub.getBlock()).timestamp);
  requireReady() {
    if (this.status !== "ready") throw new RailError(this.status === "starting" ? "rail_starting" : "rail_unavailable", this.status === "starting" ? "The local chain is still starting; try again in a few seconds." : `The local chain is unavailable: ${this.error ?? this.status}`, 503);
  }
  /** Every workspace of the host, including the baseline one. */
  all(): Rail[] { return [...this.workspaces.values()]; }
  workspace(id: string): Rail | undefined { return this.workspaces.get(id); }

  // ───────────────────────────── lifecycle ─────────────────────────────
  async start(): Promise<void> {
    this.status = "starting";
    this.error = null;
    this.startedAt = this.iso();
    try {
      mkdirSync(join(this.cfg.railDir, "records"), { recursive: true });
      this.store = new Store(this.cfg.dbPath);
      // A data folder belongs to one mode: a single-tenant chain is never served as multi-tenant, or the other way round.
      const stored = this.store.meta<string>("mode") ?? (this.store.meta("genesis") ? "baseline-parity" : null);
      if (stored && stored !== this.cfg.mode) throw new Error(`This data folder holds a ${stored} chain, but the rail was started in ${this.cfg.mode} mode. Nothing was changed: start it with QED_RAIL_MODE=${stored}, or use a new data folder.`);
      if (this.cfg.mode === "baseline-parity" && !this.baseline) throw new Error("baseline-parity mode needs the baseline workspace (use createRail).");
      if (this.cfg.zk) {
        const assembler = "../scripts/assemble-tree.mjs";
        (await import(assembler)).assembleTree({ dest: this.cfg.vendorRoot, withZk: true });
      }
      const check = verifyVendoredTree(this.cfg.vendorRoot, this.cfg.zk);
      this.vendoredOk = check.ok;
      if (!check.ok) throw new Error(`The vendored release files do not match their recorded hashes: ${check.problems.slice(0, 5).join(", ")}${check.problems.length > 5 ? ` and ${check.problems.length - 5} more` : ""}. Nothing was loaded.`);
      this.v = await loadVendored(this.cfg.vendorRoot);
      this.brain = new this.v.offline.OfflineBrain();
      // the secrets' folder is locked while they are sealed (or sealing is on), before anything else is stopped or
      // started here (leftover runs reaped, the chain's start ending whatever process its pid file names), so a second
      // service on this folder is refused first (review of 09db70b M-3; re-checks N-3), and the operator's seal and
      // unseal cannot change a file in use
      if (sealingOn() || anySealed(this.cfg.railDir, ["master.key", "cosigner.key"])) this.#unlockSecrets = lockFolder(this.cfg.railDir);
      this.reapEphemeral();
      // the chain listens only on a port browsers refuse and is driven over its private socket (F-14); cfg.anvilPort is
      // where a chain started before R13 listened, kept only to recognise one left running
      this.anvil = new Anvil({ bin: this.cfg.anvilBin, stateFile: join(this.cfg.railDir, "anvil-state.hex"), pidFile: join(this.cfg.railDir, "anvil.pid"), legacyPort: this.cfg.anvilPort });
      this.anvil.onExit(() => void this.onChainExit());
      const { reapedOrphan } = await this.anvil.start();
      // receipts looked for every 100 ms, not viem's 4 s: on this chain a transaction is mined milliseconds after it is sent
      this.c = quickReceipts(new this.v.chain.Chain$(this.anvil.url, CHAIN_ID, FEES));
      if (this.cfg.mode === "multi-tenant") {
        // a chain created before is created with a master secret: a missing one is refused, and one that is not the one
        // recorded at genesis is refused (review of 09db70b, M-4); a genesis from before the check records it now
        const before = this.store.meta<Record<string, unknown> & { masterCheck?: string }>("genesis");
        this.#master = loadOrCreateMasterSecret(join(this.cfg.railDir, "master.key"), { mustExist: before !== null && before !== undefined });
        const check = masterCheckOf(this.#master);
        if (before?.masterCheck && before.masterCheck !== check) throw new Error("This wallet service's master secret is not the one its chain was created with; nothing was derived or changed. Restore the right master.key.sealed (or master.key) from the newest wallet-service archive (docs/ENCRYPTION.md section 9).");
        if (before && !before.masterCheck) this.store.setMeta("genesis", { ...before, masterCheck: check });
        this.#hostKeys = { deployer: derivedAccount(this.#master, "host:deployer"), cloudco: derivedAccount(this.#master, "host:payee:cloudco"), denied: derivedAccount(this.#master, "host:denylisted"), keeper: derivedAccount(this.#master, "host:market-keeper") };
        this.denyList = loadDenyList(this.cfg.railDir, [this.#hostKeys.denied.address]);
      }
      await this.openChainDoor();
      this.cosigner = await this.makeCosigner();
      const genesis = this.store.meta<{ id: string; at: string; addresses?: Addresses; market?: MarketAddresses }>("genesis");
      if (!genesis) await this.deployFresh();
      else await this.restore(genesis, reapedOrphan);
      this.currencyMarket = this.store.meta<CurrencyMarket>("currencyMarket") ?? emptyCurrencyMarket();
      await this.ensureBounties();
      await this.ensureDisputes();
      if (this.cfg.mode === "baseline-parity") await this.attachBaseline();
      // A workspace whose creation stopped is not attached here: it is completed below. That holds whether it stopped
      // before its contracts existed or after the registry recorded them (R14): the chain is saved only when a creation
      // ends, so the saved chain may not hold the contracts the registry names, and attaching would read contracts that
      // are not there. One unfinished workspace must never keep every other household's wallet from starting.
      else for (const row of this.store.workspaceRows()) if (row.status !== "deploying" && parse<any>(row.spec)?.contracts) await this.attachWorkspace(row.id as string);
      this.#gaps = new GapDetector(this.cfg.wallClock, this.cfg.monoClock, this.cfg.gapSeconds * 1000);
      // a workspace whose creation was interrupted is completed now, from where it stopped, before the host is ready
      if (this.cfg.mode === "multi-tenant") for (const row of this.store.workspaceRows()) if (row.status === "deploying") await this.writer(() => this.provision(row.id as string)).catch((e) => this.cfg.log(`workspace ${row.id} could not be completed: ${publicError(e)}`));
      this.status = "ready";
      // a scripted-economy runner left behind by a killed rail is stopped before any job is resumed
      this.all()[0]?.economies?.reapOrphan();
      for (const ws of this.all()) await ws.recoverJobs();
      this.#heartbeat = setInterval(() => void this.tick(), this.cfg.heartbeatMs);
      this.#heartbeat.unref();
    } catch (e) {
      this.status = "failed";
      this.error = publicError(e).slice(0, 300);
      throw e;
    }
  }

  async stop(): Promise<void> {
    if (this.#heartbeat) clearInterval(this.#heartbeat);
    this.#heartbeat = null;
    const was = this.status;
    this.status = "stopped";
    for (const ws of this.all()) ws.economies?.stop();
    for (const ws of this.all()) await ws.drain();
    try { await this.#writer; } catch { /* a failed job is already recorded */ }
    try { if (was === "ready") await this.checkpoint(); } catch { /* the last per-job checkpoint stands */ }
    await this.cosigner?.stop().catch(() => {});
    await this.chainDoor?.close().catch(() => {});
    this.chainDoor = null;
    await this.anvil?.stop().catch(() => {});
    for (const ws of this.all()) if (ws.store !== this.store) ws.store?.close();
    this.store?.close();
    this.#unlockSecrets?.(); // after the co-signer, which reads its key file, has stopped
    this.#unlockSecrets = null;
    await (globalThis as { curve_bn128?: { terminate?: () => Promise<void> } }).curve_bn128?.terminate?.().catch(() => {});
  }

  /**
   * R14: the chain's read-only door, open only when the co-signer is its own process and has been given a folder for it
   * (QED_COSIGNER_CHAIN_DIR: in the container, a folder of this service's user and the co-signer's group). Null on a
   * development machine, where the co-signer is this user and uses the chain's own socket, as before.
   */
  chainDoor: ReadOnlyDoor | null = null;
  /** The socket the co-signer reaches the chain by: the read-only door when there is one, else the chain's own. */
  private get cosignerChainSocket(): string { return this.chainDoor?.path ?? this.anvil.socketPath; }
  /**
   * Opens the door before the co-signer is configured for anything. A co-signer that runs as another user and has no
   * door could not read the chain: that is refused here, at start, in words, instead of failing at the first payment.
   */
  private async openChainDoor(): Promise<void> {
    const dir = this.cfg.cosigner === "process" ? process.env.QED_COSIGNER_CHAIN_DIR : undefined;
    if (!dir) {
      if (this.cfg.cosigner === "process" && process.env.QED_COSIGNER_UID) throw new Error("The co-signer runs as its own user and has no way to read the chain: QED_COSIGNER_CHAIN_DIR names no folder for the chain's read-only door (scripts/deploy/entrypoint.sh makes it). Nothing was started.");
      return;
    }
    this.chainDoor = await startReadOnlyDoor(join(dir, "chain.sock"), this.anvil.socketPath);
  }

  /**
   * Where the co-signer keeps one workspace's decision records (R14; cosigner-env.ts cosignerRecordsDir): in its own
   * folder when it runs as its own process with one (the container: another user, who cannot enter this service's data
   * folder), else in the workspace's own records folder, as before.
   */
  private cosignerRecords(id: string, workspaceRecords: string): string {
    return cosignerRecordsDir(this.cfg.cosigner === "process" ? process.env.QED_COSIGNER_STATE_DIR : null, id, workspaceRecords);
  }

  protected async makeCosigner(): Promise<CosignerHost> {
    if (this.cfg.cosigner === "process") {
      const { ProcessCosigner } = await import("./cosigner-client.ts");
      // the co-signer's state (its nonces and revocations) in a folder of its own when it runs as its own user (R13
      // review fix F3: the container's entrypoint makes QED_COSIGNER_STATE_DIR that user's and moves an earlier file there)
      return ProcessCosigner.start({ keyFile: join(this.cfg.railDir, "cosigner.key"), vendorRoot: this.cfg.vendorRoot, stateFile: join(process.env.QED_COSIGNER_STATE_DIR || this.cfg.railDir, "cosigner-state.json") });
    }
    // In the rail's own process (labelled so in every view). The baseline scope keeps the release's development key so
    // that tests can play an attacker who stole it; any other scope's key is derived from this installation's secret.
    const master = this.#master;
    return new InProcessCosigner(this.v, (scope, version) => {
      if (scope === BASELINE_WORKSPACE) return devAccount("COSIGNER", version);
      if (!master) throw new Error("no master secret for this co-signer scope");
      return derivedAccount(master, `cosigner:${scope}:v${version}`);
    }, join(this.cfg.railDir, "cosigner-state.json"));
  }

  private async deployFresh(): Promise<void> {
    this.genesisId = randomUUID();
    if (this.cfg.mode === "baseline-parity") {
      const K = Object.fromEntries((["DEPLOYER", "OPERATOR", "GUARDIAN", "LP1", "LP2", "LP3", "MALLORY"] as const).map((r) => [r, devAccount(r, r === "OPERATOR" || r === "GUARDIAN" ? this.store.meta<number>(`keyVersion:${r}`) ?? 1 : 1)])) as never;
      const cosigner = await this.cosigner.address(BASELINE_WORKSPACE);
      this.baselineAddresses = await deployReleaseSandbox(this.c, this.v, this.rpc, K, devAccount("OWNER").address, cosigner);
      this.store.setMeta("genesis", { id: this.genesisId, at: this.iso(), addresses: this.baselineAddresses, cosigner, release: RELEASE_ID });
      this.store.setMeta("mode", "baseline-parity");
      this.store.setMeta("provisioned", false);
      await this.checkpoint();
      this.store.appendClockEvent(this.iso(), "start", { note: "fresh chain deployed", chainSeconds: await this.latestTs(), wallSeconds: Math.floor(this.now() / 1000) });
      this.store.appendHistory({ at: this.iso(), kind: "genesis", title: "Local chain deployed from the release's embedded bytecode: 100 tUSD in the treasury, empty euro reserve, five venues. Awaiting the owner's provisioning approval.", outcome: "no-action", jobId: null });
      return;
    }
    this.market = await deployMarket(this.c, this.v, this.rpc, { deployer: this.#hostKeys!.deployer });
    this.store.setMeta("genesis", { id: this.genesisId, at: this.iso(), market: this.market, release: RELEASE_ID, ...(this.#master ? { masterCheck: masterCheckOf(this.#master) } : {}) });
    this.store.setMeta("mode", "multi-tenant");
    await this.checkpoint();
    this.store.appendClockEvent(this.iso(), "start", { note: "fresh shared chain deployed: the test market, no workspace yet", chainSeconds: await this.latestTs(), wallSeconds: Math.floor(this.now() / 1000) });
  }

  /** After a restart: load the last durable chain state, check it against the store, and realign the clock forward. */
  private async restore(genesis: { id: string; addresses?: Addresses; market?: MarketAddresses }, reapedOrphan: boolean): Promise<void> {
    this.genesisId = genesis.id;
    this.baselineAddresses = genesis.addresses ?? null;
    this.market = genesis.market ?? null;
    if (!this.anvil.hasState()) throw new Error("The store holds a deployed chain, but its saved state file is missing. Nothing was redeployed over the existing records.");
    await this.anvil.loadState();
    const cp = this.store.meta<{ block: string; hash: string; at: string }>("checkpoint");
    const block = await this.pub.getBlock();
    const probe = this.baselineAddresses ? [this.baselineAddresses.vault, this.baselineAddresses.exec] : [this.market!.lens, this.market!.inr];
    const codes = await Promise.all(probe.map((address) => this.pub.getCode({ address })));
    if (codes.some((x) => !x || x.length <= 2)) throw new Error("The saved chain state does not contain the recorded contracts.");
    if (cp && BigInt(block.number) < BigInt(cp.block)) throw new Error(`The saved chain state (block ${block.number}) is older than the last recorded checkpoint (block ${cp.block}).`);
    this.restoredFromState = true;
    let event: Record<string, unknown>;
    try {
      const a = await anchor(this.rpc, this.latestTs, this.now(), this.cfg.maxClockLeadSeconds);
      event = { note: "restart: chain state restored and realigned", chainBefore: a.before.chainSeconds, chainAfter: a.chainAfter, wallSeconds: a.before.wallSeconds, behindSeconds: a.before.skewSeconds, lastCheckpointAt: cp?.at ?? null, restoredBlock: block.number.toString(), orphanedChainStopped: reapedOrphan };
    } catch (e) {
      if (!(e instanceof ClockSkewError)) throw e;
      event = { note: "restart: the restored chain is ahead of the wall clock; transactions are refused until the wall clock catches up", ...e.details };
    }
    this.store.appendClockEvent(this.iso(), "restart", event);
    await this.checkpoint();
  }

  /** The vault knows one co-signer address: a chain created under the other co-signer arrangement is not served. */
  private async requireRegisteredCosigner(scope: string, vault: Address) {
    const registered = getAddress((await this.pub.readContract({ address: vault, abi: this.v.abi.QEDVaultAbi, functionName: "cosigner" })) as Address);
    const mine = getAddress(await this.cosigner.address(scope));
    if (registered !== mine) throw new Error(`The chain's registered co-signer is ${registered}, but this rail's co-signer (${this.cosigner.isolation}) is ${mine}. The chain was created under the other co-signer arrangement: start the rail with QED_RAIL_COSIGNER=${this.cosigner.isolation === "separate-process" ? "in-process" : "process"}, as it was created. Nothing was changed.`);
  }

  private async attachBaseline(): Promise<void> {
    const ws = this.baseline!;
    const a = this.baselineAddresses!;
    if (this.restoredFromState) await this.requireRegisteredCosigner(BASELINE_WORKSPACE, a.vault);
    ws.store = this.store;
    ws.recordsDir = join(this.cfg.railDir, "records");
    ws.K = Object.fromEntries((["DEPLOYER", "OPERATOR", "GUARDIAN", "LP1", "LP2", "LP3", "MALLORY", "CLOUDCO"] as const).map((r) => [r, devAccount(r, r === "OPERATOR" || r === "GUARDIAN" ? this.store.meta<number>(`keyVersion:${r}`) ?? 1 : 1)])) as RailService["K"];
    ws.roleKey = (role, version) => devAccount(role, version);
    ws.relayer = null;
    ws.a = { ...a, asset: a.usd, reserveAsset: a.eur, ownerAccount: null };
    ws.asset = { symbol: "tUSD", decimals: 6 };
    ws.reserveAsset = { symbol: "tEUR", decimals: 6 };
    ws.venueDefs = this.v.scenario.EXEC_VENUES.map((x: any) => ({ label: x.label, feeBps: x.feeBps }));
    ws.owner = new ReleaseDevelopmentOwner(new OwnerSigner(devAccount("OWNER")));
    ws.cosigner = scopedPort(this.cosigner, BASELINE_WORKSPACE);
    ws.summary = { id: BASELINE_WORKSPACE, status: "ready", guards: [], ownerKind: "release-development-owner", ownerCustody: ws.owner.custody, ownerAccount: null, ownerAccountBuild: null, signers: [], threshold: null, asset: { symbol: "tUSD", decimals: 6, address: a.usd }, reserveAsset: { symbol: "tEUR", decimals: 6, address: a.eur }, grant: null, createdAt: this.store.meta<{ at: string }>("genesis")!.at };
    await ws.cosigner.configure({ rpcUrl: this.anvil.url, chainSocket: this.cosignerChainSocket, chainId: CHAIN_ID, vault: a.vault, lens: a.lens, escrow: a.vault, owner: ws.owner.address, denylist: [ws.K.MALLORY.address], deployBlock: a.deployBlock, recordsDir: this.cosignerRecords(BASELINE_WORKSPACE, ws.recordsDir), engine: "release" });
    this.workspaces.set(BASELINE_WORKSPACE, ws);
  }

  /**
   * The local refutation bounties: deployed, opened and funded once per shared chain, or reused (rail/bounties.ts).
   * Multi-tenant chains only (the baseline-parity chain stays exactly the release's sandbox). A failure here leaves the
   * rest of the host working and is reported by GET /workspaces/:id/bounties.
   */
  private async ensureBounties(): Promise<void> {
    if (this.cfg.mode !== "multi-tenant") { this.bountyStatus = { state: "off", reason: "The baseline-parity chain is the release's sandbox only; it has no bounty board." }; return; }
    if (!this.cfg.bounty.enabled) { this.bountyStatus = { state: "off", reason: "The bounty board is turned off on this rail (QED_RAIL_BOUNTIES=0)." }; return; }
    try {
      this.bountyBoard = await ensureBountyBoard({ c: this.c, v: this.v, rpc: this.rpc, store: this.store, deployer: this.#hostKeys!.deployer, market: this.market!, cfg: this.cfg, iso: this.iso, checkpoint: () => this.checkpoint() });
      this.bountyStatus = { state: "ready" };
    } catch (e) {
      this.bountyBoard = null;
      this.bountyStatus = { state: "unavailable", reason: `The bounty board could not be set up: ${publicError(e).slice(0, 300)}` };
      this.cfg.log(this.bountyStatus.reason!);
    }
  }
  /**
   * The dispute escrow in front of the shared proof escrow: deployed once per shared chain, or reused (rail/disputes.ts).
   * Multi-tenant chains only. A failure leaves the rest of the host working; work with a dispute step is then refused.
   */
  private async ensureDisputes(): Promise<void> {
    if (this.cfg.mode !== "multi-tenant") { this.disputeStatus = { state: "off", reason: "The baseline-parity chain is the release's sandbox only; it has no dispute escrow." }; return; }
    try {
      this.disputes = await ensureDisputeEscrow({ c: this.c, rpc: this.rpc, store: this.store, deployer: this.#hostKeys!.deployer, market: this.market!, iso: this.iso, checkpoint: () => this.checkpoint() });
      this.disputeStatus = { state: "ready" };
      if (!this.decodeAbis().includes(this.disputes.abi)) this.decodeAbis().push(this.disputes.abi);
    } catch (e) {
      this.disputes = null;
      this.disputeStatus = { state: "unavailable", reason: `The dispute escrow could not be set up: ${publicError(e).slice(0, 300)}` };
      this.cfg.log(this.disputeStatus.reason!);
    }
  }
  /** The key a workspace claims bounties with: derived from this installation's secret; it holds no owner authority. */
  bountyClaimant(id: string): LocalAccount {
    if (!this.#master) throw new RailError("bounties_unavailable", "This rail has no installation secret to derive a claimant key from.", 503);
    return derivedAccount(this.#master, `workspace:${id}:bounty-claimant`);
  }

  // ───────────────────────────── workspaces (multi-tenant) ─────────────────────────────
  private workspaceKeys(id: string) {
    const m = this.#master!;
    return { deployer: derivedAccount(m, `workspace:${id}:deployer`), relayer: derivedAccount(m, `workspace:${id}:relayer`), sentinel: derivedAccount(m, `workspace:${id}:sentinel`), agent: (v: number) => derivedAccount(m, `workspace:${id}:agent:v${v}`), guardian: (v: number) => derivedAccount(m, `workspace:${id}:guardian:v${v}`) };
  }
  private workspaceDir = (id: string) => join(this.cfg.railDir, "workspaces", id);

  /** Validates and normalises a POST /workspaces body. Throws 422 invalid_workspace with the reason. */
  normaliseRequest(body: unknown): Omit<CreateWorkspaceRequest, "currencies"> & { members: { x: Hex; y: Hex }[]; threshold: number; adminThreshold: number; origin: string; recovery: { x: Hex; y: Hex }[]; currencies: AssetSet | null; timeLock: boolean } {
    const bad = (m: string) => new RailError("invalid_workspace", m, 422);
    if (!body || typeof body !== "object" || Array.isArray(body)) throw bad("Supply { workspaceId, owner: { x, y }, rpIdHash }.");
    const b = body as Record<string, unknown>;
    if (Object.keys(b).some((k) => !["workspaceId", "owner", "rpIdHash", "origin", "recovery", "currencies", "authorization", "timeLock"].includes(k))) throw bad("A workspace takes { workspaceId, owner, rpIdHash, origin?, recovery?, currencies?, authorization?, timeLock? } and nothing else.");
    // R13: the time-lock, chosen at set-up (default off: the request every earlier workspace sent)
    if (b.timeLock !== undefined && typeof b.timeLock !== "boolean") throw bad("timeLock is true or false.");
    // S5: a currency set; the default, spelt out or left out, is the same request as before S5
    let currencies: AssetSet | null = null;
    if (b.currencies !== undefined) {
      try { const s = checkAssetSet(b.currencies); currencies = isDefaultSet(s) ? null : s; } catch (e) { if (e instanceof AssetSetError) throw new RailError("invalid_currencies", `${e.message} Nothing was created.`, 422); throw e; }
    }
    const id = b.workspaceId;
    if (typeof id !== "string" || !SCOPE_RE.test(id) || RESERVED.has(id)) throw bad("workspaceId must be 3 to 63 characters of lower-case letters, digits and hyphens, starting with a letter or digit, and not a reserved name.");
    const key = (k: unknown, what: string): { x: Hex; y: Hex } => {
      const o = k as Record<string, unknown> | null;
      const hex = (v: unknown) => typeof v === "string" && /^0x[0-9a-fA-F]{1,64}$/.test(v);
      if (!o || typeof o !== "object" || Array.isArray(o) || Object.keys(o).some((z) => z !== "x" && z !== "y") || !hex(o.x) || !hex(o.y)) throw bad(`${what} must be { x, y }: the P-256 public key, each coordinate 0x-prefixed hex of at most 32 bytes.`);
      const x = `0x${BigInt(o.x as string).toString(16).padStart(64, "0")}` as Hex, y = `0x${BigInt(o.y as string).toString(16).padStart(64, "0")}` as Hex;
      try { createPublicKey({ key: { kty: "EC", crv: "P-256", x: Buffer.from(x.slice(2), "hex").toString("base64url"), y: Buffer.from(y.slice(2), "hex").toString("base64url") }, format: "jwk" }); } catch { throw bad(`${what} is not a point on the P-256 curve.`); }
      return { x, y };
    };
    const o = b.owner as Record<string, unknown> | null;
    let members: { x: Hex; y: Hex }[], threshold: number, adminThreshold: number;
    if (o && typeof o === "object" && "signers" in o) {
      if (Object.keys(o).some((z) => !["signers", "threshold", "adminThreshold"].includes(z)) || !Array.isArray(o.signers) || o.signers.length < 1 || o.signers.length > 12) throw bad("owner.signers must list 1 to 12 passkey public keys.");
      members = o.signers.map((s, i) => key(s, `owner.signers[${i}]`));
      threshold = o.threshold as number;
      adminThreshold = o.adminThreshold === undefined ? threshold : (o.adminThreshold as number);
      if (!Number.isInteger(threshold) || threshold < 1 || threshold > members.length || !Number.isInteger(adminThreshold) || adminThreshold < threshold || adminThreshold > members.length) throw bad("Thresholds must satisfy 1 ≤ threshold ≤ adminThreshold ≤ number of signers.");
    } else {
      members = [key(o, "owner")];
      threshold = adminThreshold = 1;
    }
    const rp = b.rpIdHash;
    if (typeof rp !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(rp) || /^0x0+$/.test(rp)) throw bad("rpIdHash must be the SHA-256 of the WebAuthn relying-party id: 0x followed by 64 hexadecimal characters.");
    const origin = b.origin === undefined ? DEFAULT_ORIGIN : b.origin;
    if (typeof origin !== "string" || origin.length < 8 || origin.length > 200 || !/^[\x21-\x7e]+$/.test(origin) || /["\\]/.test(origin)) throw bad("origin must be printable ASCII without quotes or backslashes, for example http://localhost:5175.");
    const recovery = b.recovery === undefined ? [] : Array.isArray(b.recovery) && b.recovery.length <= 4 ? b.recovery.map((r, i) => key(r, `recovery[${i}]`)) : (() => { throw bad("recovery lists at most 4 public keys."); })();
    const ids = [...members, ...recovery].map((k) => `${k.x}:${k.y}`.toLowerCase());
    if (new Set(ids).size !== ids.length) throw bad("Every passkey and recovery key must be different.");
    return { workspaceId: id, owner: o && "signers" in o ? { signers: members, threshold, adminThreshold } : members[0], rpIdHash: rp.toLowerCase() as Hex, origin, recovery, members, threshold, adminThreshold, currencies, ...(b.authorization !== undefined ? { authorization: b.authorization as never } : {}), timeLock: b.timeLock === true };
  }

  /**
   * S5: a currency set other than the default is taken only under the owner's passkey signature over its configuration
   * (shared/chain-assets.ts assetSetDocument): as many members as the account's admin threshold, each assertion checked
   * as the owner account would check it (webauthn.ts verifyAssertionOffChain), before anything is spent or deployed.
   * Returns the evidence kept in the workspace's record; throws 403 currencies_not_signed with the document and its digest.
   */
  private verifyCurrencies(req: ReturnType<RailHost["normaliseRequest"]>, set: AssetSet) {
    const document = assetSetDocument({ workspaceId: req.workspaceId, rpIdHash: req.rpIdHash, origin: req.origin, members: req.members, threshold: req.threshold, adminThreshold: req.adminThreshold, currencies: set });
    const digest = assetSetDigest(document);
    const refuse = (why: string) => new RailError("currencies_not_signed", `This workspace takes a currency set other than the default (tINR, tUSD, tEUR) only with its owner's passkey signature over that configuration: ${why}. Nothing was created.`, 403, { digest, document });
    const a = req.authorization as { assertions?: unknown } | undefined;
    if (!a || typeof a !== "object" || Array.isArray(a) || Object.keys(a).some((k) => k !== "assertions") || !Array.isArray(a.assertions) || !a.assertions.length) throw refuse("no signature was supplied");
    if (a.assertions.length > MAX_ASSERTIONS) throw refuse(`at most ${MAX_ASSERTIONS} assertions are read`);
    const hex = (v: unknown) => typeof v === "string" && /^0x[0-9a-fA-F]{1,64}$/.test(v);
    const signed = new Map<string, Hex>(), problems: string[] = [];
    for (const x of a.assertions as { publicKey?: { x?: unknown; y?: unknown } }[]) {
      const pk = x?.publicKey;
      const member = pk && hex(pk.x) && hex(pk.y) ? req.members.find((m) => BigInt(m.x) === BigInt(pk.x as string) && BigInt(m.y) === BigInt(pk.y as string)) : undefined;
      if (!member) { problems.push("a signature is by a key that is not a member of the workspace"); continue; }
      const why = verifyAssertionOffChain(x as never, { digest, rpIdHash: req.rpIdHash, origin: req.origin, key: member });
      if (why) { problems.push(why); continue; }
      signed.set(`${member.x}:${member.y}`, signerIdOf(BigInt(member.x), BigInt(member.y)));
    }
    if (signed.size < req.adminThreshold) throw refuse(`${signed.size} valid member signature${signed.size === 1 ? "" : "s"}, but ${req.adminThreshold} of the workspace's members must sign it${problems.length ? ` (${problems[0]})` : ""}`);
    return { digest, document, assertions: a.assertions, signers: [...signed.values()], verifiedAt: this.iso() };
  }

  /**
   * POST /workspaces. Idempotent by workspaceId: the same body again returns the same workspace (duplicate: true); a
   * different body is 409 workspace_exists. Provisioning needs no further approval of the service's own: it deploys
   * the owner account and the vault set, owned by the account from their first block, and grants valueless test tINR.
   */
  async createWorkspace(body: unknown): Promise<WorkspaceView> {
    this.requireReady();
    if (this.cfg.mode !== "multi-tenant") throw new RailError("baseline_parity_mode", "This rail runs in baseline-parity mode: one workspace with the release's development owner, for the parity tests only. Workspaces are created on a multi-tenant rail.", 409);
    const req = this.normaliseRequest(body);
    const set = req.currencies;
    // S5: under the release's rule the co-signer's allowance is a fixed 10 units of whatever the vault holds, so another
    // token would change the authority's value; the authority budget's figures are carried into the token (fromInr)
    if (set && this.cfg.authority !== "d7") throw new RailError("currencies_need_authority_budget", "A currency set other than the default runs only under the authority budget (QED_RAIL_AUTHORITY=d7), whose figures are carried into the treasury's token at the test market's genesis rates. Under the release's rule the co-signer's allowance is a fixed 10 units of any token. Nothing was created.", 409);
    const signedSet = set ? this.verifyCurrencies(req, set) : null;
    // the default's request hash is exactly what it was before S5 (and before R13's time-lock, which enters only when
    // chosen), so every existing workspace answers as it did
    const requestHash = hashTerms({ workspaceId: req.workspaceId, members: req.members, threshold: req.threshold, adminThreshold: req.adminThreshold, rpIdHash: req.rpIdHash, origin: req.origin, recovery: req.recovery, ...(set ? { currencies: set } : {}), ...(req.timeLock ? { timeLock: true } : {}) });
    const existing = this.store.workspace(req.workspaceId);
    if (existing && existing.request_hash !== requestHash) throw new RailError("workspace_exists", "A workspace with this id already exists with a different owner or settings. Nothing was changed.", 409);
    if (existing && existing.status === "ready") return { ...this.workspaces.get(req.workspaceId)!.view(), duplicate: true };
    let art: ReturnType<typeof loadAccountArtifact>;
    try { art = loadAccountArtifact(this.cfg.ownerAccountBuild); } catch (e) { if (e instanceof OwnerAuthorityError) throw new RailError(e.code, e.message, e.http, e.details); throw e; }
    if (!existing && req.timeLock && !accountTakesOwnerOptions(art.abi)) throw new RailError("time_lock_unavailable", "This owner-account build has no time-lock, so a wallet cannot start with one. Nothing was created.", 422);
    if (!existing) {
      this.requireGlobal("workspaces");
      const signers = [...req.members.map((k) => ({ ...k, role: "member" as const })), ...req.recovery.map((k) => ({ ...k, role: "recovery" as const }))].map((s) => ({ signerId: signerIdOf(BigInt(s.x), BigInt(s.y)), ...s }));
      // S5: the service's figures in tINR, carried into the treasury's token and rounded down (unchanged for tINR)
      const inTreasury = (paise: bigint) => (set ? fromInr(paise, set.treasury) : paise).toString();
      const { authorization: _signatures, currencies: _set, ...request } = req;
      const spec = { request, signers, threshold: req.threshold, adminThreshold: req.adminThreshold, delays: { delaySeconds: this.cfg.accountDelaySeconds, recoveryDelaySeconds: this.cfg.accountRecoveryDelaySeconds }, accountBuild: { sha256: art.sha256, bytecodeSha256: art.bytecodeSha256, solc: art.solc, declaredReady: art.readiness.declared, label: art.readiness.declared ? `declared ready by ${art.readiness.source}` : `UNREVIEWED build: chain/accounts has not declared it ready (${art.readiness.reason}); used because QED_RAIL_OWNER_ACCOUNT_BUILD=unreviewed` }, accountAbi: art.abi, accountBytecode: art.bytecode, dailyCap: inTreasury(this.cfg.workspaceDailyCapINR), grantPlan: { vault: inTreasury(this.cfg.faucet.vaultINR), ownerAccount: inTreasury(this.cfg.faucet.ownerINR) }, ...(set ? { currencies: set, currencyAuthorization: signedSet } : {}), createdAt: this.iso() };
      this.store.tx(() => {
        this.spendGlobal("workspaces");
        this.store.insertWorkspace({ id: req.workspaceId, status: "deploying", spec, requestHash, at: this.iso() });
      });
    }
    await this.writer(() => this.provision(req.workspaceId));
    return { ...this.workspaces.get(req.workspaceId)!.view(), duplicate: !!existing };
  }

  /** S5: a workspace's currency set, as its record holds it; a record without one (every workspace before S5) is the default. */
  setOf(spec: { currencies?: AssetSet } | null | undefined): AssetSet {
    return spec?.currencies ?? DEFAULT_ASSET_SET;
  }
  /**
   * The tokens and venues of a currency set on the shared chain: the market's own for the default (unchanged since R7),
   * the S5 record's for any other (deployed by provision, before the workspace's vaults). `deep` is the deep pool's
   * genesis reserves, the reference band's centre.
   */
  setMarket(set: AssetSet): { asset: Address; reserve: Address; route: Address; pools: Address[]; venues: { label: string; feeBps: number }[]; deep: { rawA: bigint; rawB: bigint; label: string } } {
    const m = this.market!;
    if (isDefaultSet(set)) return { asset: m.inr, reserve: m.usd, route: m.eur, pools: m.inrPools, venues: INR_VENUES.map((x) => ({ label: x.label, feeBps: x.feeBps })), deep: { rawA: BigInt(INR_VENUES[0].ra) * 10n ** BigInt(INR_DECIMALS), rawB: BigInt(INR_VENUES[0].rb) * 10n ** 6n, label: INR_VENUES[0].label } };
    const cm = this.currencyMarket, plan = venuePlan(set);
    const token = (c: AssetSet["treasury"]) => tokenOf(c, m, cm) ?? (() => { throw new RailError("workspace_unavailable", `The test token of ${c} is not deployed on this chain yet.`, 503); })();
    const pools = plan.map((p) => cm.pools[poolKey(p)] ?? (() => { throw new RailError("workspace_unavailable", `The pool ${p.label} is not deployed on this chain yet.`, 503); })());
    return { asset: token(set.treasury), reserve: token(set.reserve), route: token(set.route), pools: pools.map((p) => p.address), venues: pools.map((p) => ({ label: p.label, feeBps: p.feeBps })), deep: { rawA: BigInt(pools[0].rawA), rawB: BigInt(pools[0].rawB), label: pools[0].label } };
  }

  /**
   * Deploys (or completes) one workspace (decision D-B as amended on 22 Nov 2026, docs/r7/00-ARCHITECTURE-DECISIONS.md). Every step can be repeated:
   *   1. the workspace's own deployer key creates the vault set at nonces 0 to 3 while it is their temporary owner and
   *      the vaults hold nothing, and configures it: agent, venues (co-signer, guardian, caps and the policy
   *      contract's agent are constructor arguments);
   *   2. it deploys the owner account at nonce 4 with the guard list chain/accounts builds from those addresses
   *      (releaseGuards), so the vault set's protection-reducing setters only ever run after the account's delay;
   *   3. it offers ownership of both vaults to the account (transferOwnership). The owner's passkey accepts it with the
   *      workspace's first approval (`provision`); only after that acceptance does anything reach the vaults, the
   *      opening grant included (grant()).
   * A step whose effect is already on the chain is skipped. Runs under the writer.
   */
  private async provision(id: string): Promise<void> {
    const row = this.store.workspace(id)!;
    const spec = parse<any>(row.spec)!;
    if (row.status === "ready") return;
    const A = this.v.abi, m = this.market!, k = this.workspaceKeys(id), fn = this.v.chain.fn, dep = k.deployer;
    await this.align();
    for (const who of [dep, k.relayer, k.sentinel, k.agent(1), k.guardian(1)]) if ((await this.pub.getBalance({ address: who.address })) < parseEther("1")) await this.rpc("anvil_setBalance", [who.address, toHex(parseEther("10"))]);
    const cosigner = await this.cosigner.address(id);
    // whether this run put a contract on the chain: then the block recorded by an earlier, unfinished run is not this chain's
    let deployedNow = false;
    const deployAt = async (nonce: number, abi: unknown, bytecode: Hex, args: unknown[]): Promise<Address> => {
      const at = getContractAddress({ from: dep.address, nonce: BigInt(nonce) });
      const code = await this.pub.getCode({ address: at });
      if (code && code !== "0x") return at;
      const next = await this.pub.getTransactionCount({ address: dep.address });
      if (next !== nonce) throw new Error(`workspace ${id}: its deployer is at nonce ${next}, but contract ${nonce} is missing. Nothing more was deployed.`);
      const d = await this.c.deploy(dep, abi, bytecode, args);
      deployedNow = true;
      if (getAddress(d.address) !== at) throw new Error(`workspace ${id}: contract ${nonce} landed at ${d.address}, not ${at}.`);
      return at;
    };
    const read = (address: Address, abi: unknown, functionName: string, args: unknown[] = []) => this.pub.readContract({ address, abi, functionName, args } as never) as Promise<any>;
    // 0 · S5: a set other than the default has its test tokens and pools on the shared chain first (once per set)
    const set = this.setOf(spec);
    if (!isDefaultSet(set)) this.currencyMarket = await ensureCurrencyMarket(this.c, this.v, this.rpc, { deployer: this.#hostKeys!.deployer }, m, this.currencyMarket, set, (cm) => this.store.setMeta("currencyMarket", cm));
    const sm = this.setMarket(set);
    // 1 · the vault set, owned for now by the deployer key while it holds nothing
    const vault = await deployAt(0, A.QEDVaultAbi, A.QEDVaultBytecode, [sm.asset, dep.address, k.agent(1).address, cosigner, k.guardian(1).address, BigInt(spec.dailyCap)]);
    const reserve = await deployAt(1, A.QEDVaultAbi, A.QEDVaultBytecode, [sm.reserve, dep.address, k.agent(1).address, cosigner, k.guardian(1).address, 0n]);
    const exec = await deployAt(2, A.QEDExecutionAbi, A.QEDExecutionBytecode, [vault, k.agent(1).address]);
    const treasuryPolicy = await deployAt(3, A.QEDTreasuryPolicyAbi, A.QEDTreasuryPolicyBytecode, [exec, reserve, k.agent(1).address]);
    this.fault("mid-provision");
    // 2 · the owner account, with the guard list chain/accounts builds from those addresses (never hand-written here)
    const guards = [...releaseGuards({ vault, execution: exec, policy: treasuryPolicy }), ...releaseGuards({ vault: reserve })];
    const signers = spec.signers.map((s: any) => ({ x: BigInt(s.x), y: BigInt(s.y), role: s.role === "member" ? 1 : 2 }));
    // R13: a build with a sentinel and protective calls takes them too. The sentinel is this workspace's own derived key,
    // which can only freeze a member; the protective calls (pause, bumpEpoch, revokeMandate, policy revoke) move no money.
    const contained = accountTakesContainment(spec.accountAbi);
    const protective = contained ? [...releaseProtective({ vault, policy: treasuryPolicy }), ...releaseProtective({ vault: reserve })] : [];
    // R13: a build with owner options takes the lockable list (both vaults' withdraw, ringFence, unpause, setGuardian)
    // and whether they start time-locked (the household's choice at setup; off unless asked for).
    const options = accountTakesOwnerOptions(spec.accountAbi);
    const lockable = options ? [...releaseLockable({ vault }), ...releaseLockable({ vault: reserve })] : [];
    const ownerAccount = await deployAt(4, spec.accountAbi, spec.accountBytecode, [spec.request.rpIdHash, spec.request.origin, signers, BigInt(spec.threshold), BigInt(spec.adminThreshold), BigInt(spec.delays.delaySeconds), BigInt(spec.delays.recoveryDelaySeconds), guards, ...(contained ? [protective, k.sentinel.address] : []), ...(options ? [lockable, spec.request.timeLock === true] : [])]);
    const ownerOf = async (v: Address) => getAddress(await read(v, A.QEDVaultAbi, "owner"));
    // 3 · configured while the deployer is the temporary owner (skipped once the account owns the vault)
    if ((await ownerOf(vault)) === dep.address) {
      if (getAddress(await read(vault, A.QEDVaultAbi, "agent")) !== exec) await this.c.send(dep, vault, fn(A.QEDVaultAbi, "setAgent", [exec]));
      if (/^0x0+$/.test(await read(exec, A.QEDExecutionAbi, "venueSetHash"))) await this.c.send(dep, exec, fn(A.QEDExecutionAbi, "setVenues", [sm.pools, sm.venues.map((x) => x.feeBps)]));
    }
    // 4 · ownership offered to the owner account; its passkey accepts it with the workspace's first approval
    for (const v of [vault, reserve]) if ((await ownerOf(v)) === dep.address && getAddress(await read(v, A.QEDVaultAbi, "pendingOwner")) !== ownerAccount) await this.c.send(dep, v, fn(A.QEDVaultAbi, "transferOwnership", [ownerAccount]));
    const deployBlock = !deployedNow && spec.deployBlock ? spec.deployBlock : (await this.pub.getBlockNumber()).toString();
    const done = { ...spec, guards: guards.map((g) => ({ target: g.target, selector: g.selector, reason: g.reason })), ...(contained ? { protective: protective.map((g) => ({ target: g.target, selector: g.selector, reason: g.reason })), sentinel: k.sentinel.address } : {}), ...(options ? { lockable: lockable.map((g) => ({ target: g.target, selector: g.selector, reason: g.reason })), timeLockAtSetup: spec.request.timeLock === true } : {}), contracts: { ownerAccount, vault, reserve, exec, treasuryPolicy }, deployBlock, grant: spec.grant ?? null };
    this.store.updateWorkspace(id, "deploying", done, this.iso());
    this.fault("provision-recorded");
    const ws = await this.attachWorkspace(id);
    // R7 D7: a workspace that shares a member with this one now has this one's addresses in its principal set
    if (this.cfg.authority === "d7") for (const other of this.linkedWorkspaces(id)) { const w = this.workspaces.get(other.id); if (w) await w.cosigner.configure(this.cosignerConfig(other.id, w.recordsDir)); }
    if (!ws.store.meta("genesis")) {
      ws.store.setMeta("genesis", { id: this.genesisId, at: this.iso(), workspace: id, addresses: ws.a });
      ws.store.setMeta("provisioned", false);
      const T = ws.asset.symbol, R = ws.reserveAsset.symbol;
      ws.store.appendHistory({ at: this.iso(), kind: "genesis", title: `Workspace created: its ${T} treasury vault, ${R} reserve vault, execution module and treasury policy are deployed and configured, and ownership of both vaults is offered to its passkey owner account (${spec.signers.filter((s: any) => s.role === "member").length} member${spec.threshold > 1 ? `s, ${spec.threshold} to approve` : ""}). Nothing is in the vaults. Awaiting the owner's acceptance (the provision approval); the opening grant of test ${T} follows it.`, outcome: "no-action", jobId: null });
      ws.store.appendDecision({ at: this.iso(), kind: "workspace-created", jobId: null, verdict: "OWNERSHIP_OFFERED", clock: await this.clock(), record: { workspace: id, ownerAccount, signers: spec.signers, threshold: spec.threshold, adminThreshold: spec.adminThreshold, rpIdHash: spec.request.rpIdHash, origin: spec.request.origin, accountBuild: spec.accountBuild, contracts: done.contracts, guards: done.guards, deployer: dep.address, ...(spec.currencies ? { currencies: spec.currencies, currencyAuthorization: spec.currencyAuthorization } : {}) } });
    }
    this.store.updateWorkspace(id, "ready", done, this.iso());
    ws.summary.status = ws.provisioned ? "ready" : "awaiting-acceptance";
    await this.checkpoint();
  }

  /**
   * The opening grant from the host's faucet: minted into the vault and the owner account only once the owner account
   * owns both vaults (it accepted them), and only into an empty vault or account. Called by the workspace's
   * `provision` job, which already holds the writer. Returns the grant as recorded.
   */
  async grant(ws: RailService): Promise<{ vault: string; ownerAccount: string; token: string; txs: Hex[] }> {
    const row = this.store.workspace(ws.id)!;
    const spec = parse<any>(row.spec)!;
    if (spec.grant) return spec.grant;
    const A = this.v.abi, m = this.market!, c = spec.contracts, fn = this.v.chain.fn;
    for (const v of [c.vault, c.reserve]) {
      const owner = getAddress((await this.pub.readContract({ address: v, abi: A.QEDVaultAbi, functionName: "owner" })) as Address);
      if (owner !== getAddress(c.ownerAccount)) throw new RailError("ownership_not_accepted", "The owner account has not accepted ownership of the vaults: nothing is granted before it does.", 409);
    }
    // the treasury's own test token (tINR unless the owner signed another set), minted by the host, its minter
    const token = this.setMarket(this.setOf(spec)).asset, tokenAbi = token === m.usd ? A.TestUSDAbi : A.TestTokenAbi;
    const bal = async (who: Address) => (await this.pub.readContract({ address: token, abi: tokenAbi, functionName: "balanceOf", args: [who] })) as bigint;
    const txs: Hex[] = [];
    for (const [to, amount] of [[c.vault, BigInt(spec.grantPlan.vault)], [c.ownerAccount, BigInt(spec.grantPlan.ownerAccount)]] as const) {
      if (amount > 0n && (await bal(to)) === 0n) txs.push((await this.c.send(this.#hostKeys!.deployer, token, fn(tokenAbi, "mint", [to, amount]))).hash);
    }
    spec.grant = { vault: spec.grantPlan.vault, ownerAccount: spec.grantPlan.ownerAccount, token: CHAIN_TOKENS[this.setOf(spec).treasury].symbol, txs };
    this.store.updateWorkspace(ws.id, row.status as string, spec, this.iso());
    ws.summary.grant = spec.grant;
    return spec.grant;
  }

  /** Builds the workspace object from its registry row: store, keys, owner authority, addresses, co-signer scope. */
  private async attachWorkspace(id: string): Promise<Rail> {
    const row = this.store.workspace(id)!;
    const spec = parse<any>(row.spec)!;
    const known = this.workspaces.get(id);
    if (!spec.contracts) {
      // not deployed yet: nothing to attach; provision() will
      if (known) return known;
      throw new RailError("workspace_unavailable", "The workspace is still being created.", 503);
    }
    const ws = known ?? composeWorkspace(new RailService(this, id));
    const dir = this.workspaceDir(id);
    if (!known) {
      mkdirSync(join(dir, "records"), { recursive: true });
      ws.store = new Store(join(dir, "workspace.db"));
    }
    ws.recordsDir = join(dir, "records");
    const k = this.workspaceKeys(id), m = this.market!, c = spec.contracts;
    if (this.restoredFromState && !known) await this.requireRegisteredCosigner(id, c.vault);
    const hk = this.#hostKeys!;
    ws.K = { DEPLOYER: k.deployer, OPERATOR: k.agent(ws.store.meta<number>("keyVersion:OPERATOR") ?? 1), GUARDIAN: k.guardian(ws.store.meta<number>("keyVersion:GUARDIAN") ?? 1), LP1: hk.deployer, LP2: hk.deployer, LP3: hk.deployer, MALLORY: hk.denied, CLOUDCO: hk.cloudco };
    ws.roleKey = (role, version) => (role === "OPERATOR" ? k.agent(version) : k.guardian(version));
    ws.relayer = k.relayer;
    ws.sentinel = spec.sentinel ? k.sentinel : null;
    // S5: the workspace's currency set (the default for every record without one) and its tokens and venues
    const set = this.setOf(spec), sm = this.setMarket(set), T = CHAIN_TOKENS[set.treasury], R = CHAIN_TOKENS[set.reserve], V = CHAIN_TOKENS[set.route];
    ws.a = { usd: m.usd, eur: m.eur, eth: m.eth, lens: m.lens, pools: sm.pools, vault: c.vault, reserve: c.reserve, exec: c.exec, treasuryPolicy: c.treasuryPolicy, deployBlock: spec.deployBlock, asset: sm.asset, reserveAsset: sm.reserve, ownerAccount: c.ownerAccount };
    ws.asset = { symbol: T.symbol, decimals: T.decimals };
    ws.reserveAsset = { symbol: R.symbol, decimals: R.decimals };
    ws.currencies = set;
    ws.tokenSymbols = new Map([[getAddress(sm.asset), ws.asset], [getAddress(sm.reserve), ws.reserveAsset], [getAddress(sm.route), { symbol: V.symbol, decimals: V.decimals }]]);
    ws.venueDefs = sm.venues;
    ws.owner = new PasskeyAccountOwner(c.ownerAccount, spec.accountAbi, { pub: this.pub, relayer: k.relayer, releaseAbis: this.decodeAbis() }, spec.guards ?? [], spec.lockable ?? []);
    ws.cosigner = scopedPort(this.cosigner, id);
    ws.summary = { id, status: row.status !== "ready" ? "deploying" : ws.store.meta<boolean>("provisioned") === true ? "ready" : "awaiting-acceptance", guards: spec.guards ?? [], ownerKind: "passkey-account", ownerCustody: ws.owner.custody, ownerAccount: c.ownerAccount, ownerAccountBuild: { sha256: spec.accountBuild.sha256, solc: spec.accountBuild.solc, declaredReady: spec.accountBuild.declaredReady, label: spec.accountBuild.label }, signers: spec.signers.map((s: any) => ({ signerId: s.signerId, x: s.x, y: s.y, role: s.role })), threshold: spec.threshold, asset: { ...ws.asset, address: sm.asset }, reserveAsset: { ...ws.reserveAsset, address: sm.reserve }, currencies: { ...set, default: isDefaultSet(set), digest: spec.currencyAuthorization?.digest ?? null }, routeAsset: { symbol: V.symbol, decimals: V.decimals, address: sm.route }, grant: spec.grant ?? null, createdAt: spec.createdAt };
    ws.authorityRule = this.cfg.authority;
    await ws.cosigner.configure(this.cosignerConfig(id, ws.recordsDir));
    this.workspaces.set(id, ws);
    return ws;
  }

  /** A workspace's co-signer: the fork (D-A), with C12 the authority budget (R7 D7) unless QED_RAIL_AUTHORITY=release. */
  private cosignerConfig(id: string, recordsDir: string): CosignerConfig {
    const spec = parse<any>(this.store.workspace(id)!.spec)!, c = spec.contracts, m = this.market!;
    // S5: an order into a 0-decimal token (tJPY) cannot come within the release's 1 to 100 ppm of its bound, one unit being
    // hundreds of ppm of a small conversion: a set other than the default lets τ cover two base units (fork change 6)
    const granular = isDefaultSet(this.setOf(spec)) ? {} : { minToleranceUnits: 2 };
    const base: CosignerConfig = { rpcUrl: this.anvil.url, chainSocket: this.cosignerChainSocket, chainId: CHAIN_ID, vault: c.vault, lens: m.lens, escrow: m.escrow, owner: c.ownerAccount, denylist: this.denyList ? this.denyList.entries.map((e) => e.address) : [this.#hostKeys!.denied.address], deployBlock: spec.deployBlock, recordsDir: this.cosignerRecords(id, recordsDir), engine: "fork", ...granular };
    return this.cfg.authority === "d7" ? { ...base, authority: "d7", d7: this.authorityConfig(id) } : { ...base, authority: "release" };
  }

  /**
   * The workspaces linked to `id` for R7 D7's principal set (D1, D7's A-ID): every workspace that shares a signer
   * (member or recovery key) with it now OR EVER (the account's SignerAdded history: a key moved from one account to
   * another, or removed, still says the same person held both), and every workspace the wallet declared linked because
   * they have a member in common (POST /workspaces/:id/links; links are only ever added). Symmetric.
   */
  private linkedWorkspaces(id: string): { id: string; spec: any }[] {
    const rows = this.store.workspaceRows().map((r) => ({ id: r.id as string, spec: parse<any>(r.spec) })).filter((r) => r.spec?.contracts);
    const signersOf = (r: { spec: any }) => new Set<string>([...(r.spec.signers ?? []).map((x: any) => String(x.signerId)), ...(r.spec.everSigners ?? [])].map((x: string) => x.toLowerCase()));
    const me = rows.find((r) => r.id === id)!;
    const mine = signersOf(me), myLinks = new Set<string>(me.spec.links ?? []);
    return rows.filter((r) => r.id !== id && ([...signersOf(r)].some((x) => mine.has(x)) || myLinks.has(r.id) || (r.spec.links ?? []).includes(id)));
  }
  /** Every signer id the account of `id` has had, as last read from its SignerAdded events. */
  everSigners(id: string): Hex[] {
    const spec = parse<any>(this.store.workspace(id)?.spec);
    return [...new Set<string>([...(spec?.signers ?? []).map((x: any) => String(x.signerId).toLowerCase()), ...(spec?.everSigners ?? [])])] as Hex[];
  }
  /** Re-configures the co-signers of these workspaces, so that their principal sets follow a change of links (R7 D7). */
  private async reconfigure(ids: Iterable<string>): Promise<void> {
    if (this.cfg.authority !== "d7") return;
    for (const wid of new Set(ids)) { const w = this.workspaces.get(wid); if (w) await w.cosigner.configure(this.cosignerConfig(wid, w.recordsDir)); }
  }
  /**
   * Reads every signer the account of `id` has ever had (SignerAdded, the constructor's included) and keeps them in its
   * record. A new one links this workspace to every workspace that shares it; their co-signers are re-configured.
   */
  async syncSignerHistory(id: string): Promise<void> {
    const row = this.store.workspace(id);
    const spec = parse<any>(row?.spec);
    if (!row || !spec?.contracts?.ownerAccount || !spec.accountAbi) return;
    const logs = (await this.pub.getContractEvents({ address: spec.contracts.ownerAccount, abi: spec.accountAbi, eventName: "SignerAdded", fromBlock: 0n })) as { args: { signerId: Hex } }[];
    const known = new Set<string>(spec.everSigners ?? []);
    const seen = logs.map((l) => String(l.args.signerId).toLowerCase()).filter((x) => !known.has(x));
    if (!seen.length) return;
    const before = this.linkedWorkspaces(id).map((w) => w.id);
    const fresh = parse<any>(this.store.workspace(id)!.spec);
    fresh.everSigners = [...new Set<string>([...(fresh.everSigners ?? []), ...seen])];
    this.store.updateWorkspace(id, row.status as string, fresh, this.iso());
    const after = this.linkedWorkspaces(id).map((w) => w.id);
    await this.reconfigure([id, ...before, ...after]);
  }
  /**
   * POST /workspaces/:id/links: the wallet says these workspaces have a member in common with `id` (R7 D1), so that
   * none of them counts as an outside client of another (D7, A-ID). Links are only ever added, on both sides: adding
   * one can only make the authority budget more conservative. Unknown ids are reported and ignored.
   */
  async addLinks(id: string, others: unknown): Promise<{ linked: string[]; added: string[]; unknown: string[] }> {
    this.requireReady();
    if (!Array.isArray(others) || others.length > 64 || others.some((x) => typeof x !== "string" || !SCOPE_RE.test(x))) throw new RailError("invalid_params", "links takes { workspaces: [id, …] }: up to 64 workspace ids.", 422);
    const ids = [...new Set(others as string[])].filter((x) => x !== id);
    const unknown = ids.filter((x) => !this.store.workspace(x) || !parse<any>(this.store.workspace(x)!.spec)?.contracts);
    const real = ids.filter((x) => !unknown.includes(x));
    const added: string[] = [];
    const put = (wid: string, other: string) => {
      const row = this.store.workspace(wid)!, spec = parse<any>(row.spec)!;
      const links = new Set<string>(spec.links ?? []);
      if (links.has(other)) return false;
      links.add(other);
      spec.links = [...links].sort();
      this.store.updateWorkspace(wid, row.status as string, spec, this.iso());
      return true;
    };
    for (const other of real) { const a = put(id, other), b = put(other, id); if (a || b) added.push(other); }
    if (added.length) await this.reconfigure([id, ...added]);
    return { linked: this.linkedWorkspaces(id).map((w) => w.id).sort(), added, unknown };
  }
  /** The authority-budget configuration the co-signer of `id` uses (R7 D7), for reads that must agree with it. */
  d7ConfigOf(id: string): D7Config | null {
    return this.cfg.authority === "d7" && this.store.workspace(id) && parse<any>(this.store.workspace(id)!.spec)?.contracts ? this.authorityConfig(id) : null;
  }

  /**
   * The authority budget of one workspace's treasury vault (R7 decision D7; rail/authority-ledger.ts):
   *   C  its treasury vault, its reserve vault and its owner account: value leaves them only through the co-signer's
   *      rule or by an owner action the agent cannot perform. The agent key and the relayer are never in C (D7, F6).
   *   P  C, its execution module and policy contract, every key the service holds for it (deployer, relayer, agent and
   *      guardian keys of every version up to three beyond the current one), and the same for every workspace sharing a
   *      passkey signer with it. Receipts from P are never earnings. A member's address the rail has never seen cannot
   *      be told apart from an outside client (D7 assumption A-ID): the budget's figures say so.
   *   B0 the release's earned-autonomy base in the vault's units, 10 tINR (D-A's figure, kept); r = 1/2 (the release's
   *      half of revenue); k = 2 confirmations; the reference band of tUSD from referenceBand().
   *   K1 earned authority counts at most authorityEarnedCap.perWindow in any authorityEarnedCap.windowSeconds, at most
   *      perPayer from any one payer, and nothing of what the workspace sent a payer first (rail/earned-authority.ts).
   */
  private authorityConfig(id: string): D7Config {
    const spec = parse<any>(this.store.workspace(id)!.spec)!, c = spec.contracts, m = this.market!;
    const keysOf = (wid: string, x: any): string[] => {
      const k = this.workspaceKeys(wid), st = this.workspaces.get(wid)?.store;
      const top = Math.max(st?.meta<number>("keyVersion:OPERATOR") ?? 1, st?.meta<number>("keyVersion:GUARDIAN") ?? 1) + 3;
      const versions = Array.from({ length: top }, (_, i) => i + 1);
      return [x.contracts.vault, x.contracts.reserve, x.contracts.ownerAccount, x.contracts.exec, x.contracts.treasuryPolicy, k.deployer.address, k.relayer.address, k.sentinel.address, ...versions.flatMap((v) => [k.agent(v).address, k.guardian(v).address])];
    };
    const principal = [...keysOf(id, spec), ...this.linkedWorkspaces(id).flatMap((w) => keysOf(w.id, w.spec))].filter(Boolean).map((x) => getAddress(x));
    // S5: the budget counts in the treasury's own token; B0 and K1's caps, set in tINR, are carried into it rounded down
    // (fromInr is the identity for tINR, so a default workspace's figures are exactly what they were)
    const set = this.setOf(spec), sm = this.setMarket(set), T = CHAIN_TOKENS[set.treasury];
    return {
      vault: c.vault, asset: sm.asset, symbol: T.symbol, decimals: T.decimals, execution: [c.exec], escrow: m.escrow,
      base: fromInr(10n * 10n ** BigInt(INR_DECIMALS), set.treasury).toString(), rate: "1/2", confirmations: 2,
      control: [c.vault, c.reserve, c.ownerAccount], principal: [...new Set(principal)], references: [this.referenceBand(set)],
      earnedCap: { windowSeconds: this.cfg.authorityEarnedCap.windowSeconds, perWindow: fromInr(this.cfg.authorityEarnedCap.perWindow, set.treasury).toString(), perPayer: fromInr(this.cfg.authorityEarnedCap.perPayer, set.treasury).toString() },
      // a QEDVault releases only its own asset; the owner account (a QEDOwnerAccount) can transfer any token
      controlAssets: [{ address: c.vault, assets: [sm.asset] }, { address: c.reserve, assets: [sm.reserve] }, { address: c.ownerAccount, assets: "any" }],
    };
  }

  /**
   * The reference band of tUSD in tINR for the authority budget's conversions (R7 D7, section 2.2 of the spec), and why
   * it is fixed. The local chain has no price source the agent cannot move: every price on it is a CPMM pool's, and the
   * agent's own conversions, other workspaces' conversions and anyone holding test tokens (TestUSD has a public
   * faucet) move the pools. A band read from them could be pushed by the coalition D7 guards against, with no bound
   * that T3ε covers. So the band is set in configuration: centred on the test market's genesis rate, the deep pool of
   * INR_VENUES (8,400,000 tINR to 100,000 tUSD, 84 tINR per tUSD), ± authorityBandBps; no trade can move it. A
   * conversion is admitted only while the venues' depth-weighted mid (the release's T2 figure) lies inside the band
   * widened by authorityDivergenceBps (0 by default), so, taking that mid as the truth, A-VAL holds at every admitted
   * conversion, and T3ε's error is at most the divergence. What the band does not do: follow the market. The shared
   * pools drift one way with use (workspaces only convert tINR into tUSD); once their mid leaves the band, every
   * workspace's conversions are refused until the reference is re-centred (an owner decision; RISK in the hand-back).
   */
  private referenceBand(set: AssetSet = DEFAULT_ASSET_SET): Reference {
    if (!isDefaultSet(set)) {
      // S5: the same rule for another set: its deep pool's genesis rate ± authorityBandBps, set in configuration
      const sm = this.setMarket(set), T = CHAIN_TOKENS[set.treasury], R = CHAIN_TOKENS[set.reserve], b = referenceBandOf(sm.deep.rawA, sm.deep.rawB, this.cfg.authorityBandBps);
      const perUnit = (Number(sm.deep.rawA) / 10 ** T.decimals) / (Number(sm.deep.rawB) / 10 ** R.decimals);
      return { token: sm.reserve, symbol: R.symbol, decimals: R.decimals, ...b, divergenceBps: this.cfg.authorityDivergenceBps, source: `fixed in configuration: the test market's genesis rate for this workspace's currency set, ${sm.deep.label} at ${perUnit.toPrecision(6)} ${T.symbol} per ${R.symbol} (synthetic), ± ${this.cfg.authorityBandBps / 100}%; no trade moves it` };
    }
    const deep = INR_VENUES[0], w = BigInt(this.cfg.authorityBandBps);
    const n = BigInt(deep.ra) * 10n ** BigInt(INR_DECIMALS), d = BigInt(deep.rb) * 10n ** 6n; // tINR base units per tUSD base unit
    const frac = (x: bigint, y: bigint) => { let a = x, b = y; while (b) [a, b] = [b, a % b]; return `${x / a}/${y / a}`; };
    return {
      token: this.market!.usd, symbol: "tUSD", decimals: 6,
      lo: frac(n * (10_000n - w), d * 10_000n), mid: frac(n, d), hi: frac(n * (10_000n + w), d * 10_000n), divergenceBps: this.cfg.authorityDivergenceBps,
      source: `fixed in configuration: the test market's genesis rate, ${deep.label} at ${(Number(deep.ra) / Number(deep.rb)).toFixed(2)} tINR per tUSD, ± ${this.cfg.authorityBandBps / 100}%; no trade moves it`,
    };
  }

  // ───────────────────────────── the shared chain: persistence, clock, writer ─────────────────────────────
  async checkpoint(): Promise<void> {
    await this.anvil.dumpState();
    const b = await this.pub.getBlock();
    this.store.setMeta("checkpoint", { block: b.number.toString(), hash: b.hash, at: this.iso() });
  }

  private async onChainExit(): Promise<void> {
    if (this.status === "stopped" || this.#restarting) return;
    this.#restarting = true;
    this.status = "starting";
    this.error = this.anvil.error;
    try {
      const genesis = this.store.meta<{ id: string; addresses?: Addresses; market?: MarketAddresses }>("genesis");
      this.store.setMeta("chainRestarts", (this.store.meta<number>("chainRestarts") ?? 0) + 1);
      await this.anvil.start();
      if (genesis) await this.restore(genesis, false);
      this.status = "ready";
      this.error = null;
      for (const ws of this.all()) await ws.recoverJobs();
    } catch (e) {
      this.status = "failed";
      this.error = publicError(e).slice(0, 300);
    } finally {
      this.#restarting = false;
    }
  }

  /** One writer on the shared chain, for every workspace. How many may wait is bounded where requests are accepted. */
  writer<T>(f: () => Promise<T>): Promise<T> {
    this.writerQueued++;
    const run = this.#writer.then(f, f);
    this.#writer = run.catch(() => undefined).finally(() => { this.writerQueued--; });
    return run;
  }

  async tick(): Promise<Gap | null> {
    if (this.status !== "ready") return null;
    const gap = this.#gaps.observe();
    if (gap) await this.writer(() => this.realign(gap)).catch(() => undefined);
    // a reorganisation may have replaced a block that held a recorded transaction: jobs resting on it are corrected
    for (const ws of this.all()) await ws.reconcileChain().catch((e) => this.cfg.log(`reorg check: ${publicError(e).slice(0, 200)}`));
    if (this.cfg.keeperBps > 0 && this.cfg.mode === "multi-tenant" && this.market) await this.writer(() => this.keeperTick()).catch((e) => this.cfg.log(`keeper: ${publicError(e).slice(0, 200)}`));
    // bounty claims due for their reveal or settlement are submitted as jobs (rail/bounties.ts → advance)
    if (this.bountyBoard && this.cfg.bounty.auto) for (const ws of this.all()) await ws.bounties?.advance().catch(() => undefined);
    return gap;
  }

  /** The prices the test market's venues were deployed at, as raw reserves (rail/deploy.ts INR_VENUES; venue 3 is the release's deep tUSD/tEUR pool). */
  private marketTargets(): Map<string, Record<string, bigint>> {
    const m = this.market!, dec = (s: string) => (s === "tINR" ? INR_DECIMALS : 6), sym: Record<string, string> = { [m.inr.toLowerCase()]: "tINR", [m.usd.toLowerCase()]: "tUSD", [m.eur.toLowerCase()]: "tEUR" };
    const out = new Map<string, Record<string, bigint>>();
    for (const [i, s] of INR_VENUES.entries()) {
      const r: Record<string, bigint> = s.ra === null ? { tUSD: this.v.scenario.raw("tUSD", this.v.scenario.EXEC_VENUES[0].ra), tEUR: this.v.scenario.raw("tEUR", this.v.scenario.EXEC_VENUES[0].rb) } : { [s.a]: BigInt(s.ra) * 10n ** BigInt(dec(s.a)), [s.b]: BigInt(s.rb) * 10n ** BigInt(dec(s.b)) };
      out.set(m.inrPools[i].toLowerCase(), Object.fromEntries(Object.entries(sym).map(([addr, sy]) => [addr, r[sy]]).filter(([, v]) => v !== undefined)));
    }
    // S5: the pools deployed for chosen currency sets, at the genesis reserves they were seeded with
    for (const p of Object.values(this.currencyMarket.pools)) {
      const a = tokenOf(p.a, m, this.currencyMarket), b = tokenOf(p.b, m, this.currencyMarket);
      if (a && b) out.set(p.address.toLowerCase(), { [a.toLowerCase()]: BigInt(p.rawA), [b.toLowerCase()]: BigInt(p.rawB) });
    }
    return out;
  }
  /** One keeper pass (rail/keeper.ts): trades every venue more than keeperBps from its deployed price back to it, and records each trade. */
  private async keeperTick(): Promise<void> {
    const A = this.v.abi, fn = this.v.chain.fn, m = this.market!, K = this.#hostKeys!, targets = this.marketTargets();
    const read = (address: Address, functionName: string, args: unknown[] = []) => this.pub.readContract({ address, abi: A.CPMMPoolAbi, functionName, args } as never) as Promise<any>;
    const pools: KeeperPool[] = [];
    for (const pool of [...new Set([...m.inrPools, ...Object.values(this.currencyMarket.pools).map((p) => p.address)])]) {
      const [r0, r1] = (await read(pool, "getReserves")) as [bigint, bigint];
      const token0 = getAddress(await read(pool, "token0")), token1 = getAddress(await read(pool, "token1"));
      const t = targets.get(pool.toLowerCase())!;
      pools.push({ pool, token0, token1, r0, r1, feeBps: Number(await read(pool, "feeBps")), target0: t[token0.toLowerCase()], target1: t[token1.toLowerCase()] });
    }
    const trades = keeperTrades(pools, this.cfg.keeperBps);
    if (!trades.length) return;
    await this.align();
    for (const t of trades) {
      const p = pools.find((x) => x.pool === t.pool)!;
      const tokenAbi = getAddress(t.tokenIn) === getAddress(m.usd) ? A.TestUSDAbi : A.TestTokenAbi;
      const held = (await this.pub.readContract({ address: t.tokenIn, abi: tokenAbi, functionName: "balanceOf", args: [K.keeper.address] })) as bigint;
      const minted = held < t.amountIn ? t.amountIn - held : 0n;
      if (minted > 0n) await this.c.send(K.deployer, t.tokenIn, fn(tokenAbi, "mint", [K.keeper.address, minted])); // the host is the test tokens' minter
      if ((await this.pub.getBalance({ address: K.keeper.address })) < parseEther("1")) await this.rpc("anvil_setBalance", [K.keeper.address, toHex(parseEther("10"))]);
      await this.c.send(K.keeper, t.tokenIn, fn(tokenAbi, "transfer", [t.pool, t.amountIn]));
      const in0 = getAddress(t.tokenIn) === p.token0;
      const tx = await this.c.send(K.keeper, t.pool, fn(A.CPMMPoolAbi, "swap", [in0 ? 0n : t.amountOut, in0 ? t.amountOut : 0n, K.keeper.address, "0x"]));
      const [r0, r1] = (await read(t.pool, "getReserves")) as [bigint, bigint];
      this.store.appendDecision({ at: this.iso(), kind: "keeper-trade", jobId: null, verdict: "TRADED", record: { keeper: K.keeper.address, pool: t.pool, tokenIn: t.tokenIn, amountIn: t.amountIn.toString(), amountOut: t.amountOut.toString(), mintedToKeeper: minted.toString(), deviationBpsBefore: t.deviationBps, deviationBpsAfter: deviationBps({ ...p, r0, r1 }), tx: tx.hash } });
    }
    await this.checkpoint();
  }
  private async realign(gap: Gap): Promise<void> {
    let event: Record<string, unknown>;
    let verdict = "REALIGNED";
    try {
      const a = await anchor(this.rpc, this.latestTs, this.now(), this.cfg.maxClockLeadSeconds);
      event = { ...gap, chainBefore: a.before.chainSeconds, chainAfter: a.chainAfter, wallSeconds: a.before.wallSeconds, behindSeconds: a.before.skewSeconds, blockMined: a.mined, block: (await this.pub.getBlockNumber()).toString() };
      if (a.mined) await this.checkpoint();
    } catch (e) {
      if (!(e instanceof ClockSkewError)) throw e;
      verdict = "CHAIN_AHEAD";
      event = { ...gap, ...e.details, note: "the chain is ahead of the wall clock; transactions are refused until the wall clock catches up" };
    }
    this.store.appendClockEvent(this.iso(), gap.kind, event);
    // every workspace's own records show the gap that affected the chain it runs on
    for (const ws of this.all()) ws.store.appendDecision({ at: this.iso(), kind: "clock-gap", jobId: null, verdict, record: event });
    if (!this.all().some((ws) => ws.store === this.store)) this.store.appendDecision({ at: this.iso(), kind: "clock-gap", jobId: null, verdict, record: event });
    this.cfg.log(`clock gap (${gap.kind}): ${gap.wallSeconds} s of wall time between two heartbeats; ${verdict}`);
  }
  /** The reading every shared-chain transaction is preceded by: forward to wall time only; refused when the chain leads. */
  async align(): Promise<ClockReading> {
    const gap = this.#gaps?.observe();
    if (gap) await this.realign(gap);
    try {
      return await alignNextBlock(this.rpc, this.latestTs, this.now(), this.cfg.maxClockLeadSeconds);
    } catch (e) {
      if (e instanceof ClockSkewError) {
        this.store.appendClockEvent(this.iso(), "skew-refusal", e.details);
        throw new RailError("clock_skew", e.message, 409, e.details);
      }
      throw e;
    }
  }
  async clock(): Promise<ClockReading> {
    return reading(await this.latestTs(), this.now(), this.cfg.maxClockLeadSeconds);
  }
  async chainNow(): Promise<bigint> {
    return BigInt(Math.max(await this.latestTs(), Math.floor(this.now() / 1000)));
  }
  clockEvents = (limit = 50) => this.store.clockEvents(Math.min(Math.max(1, limit), 500)).map((r) => ({ n: Number(r.n), at: r.at, kind: r.kind, ...(parse<Record<string, unknown>>(r.event) ?? {}) }));

  // ───────────────────────────── the host's budget, over all workspaces ─────────────────────────────
  private globalBudget(cls: QuotaClass | "workspaces") {
    const windowMs = this.cfg.quota.windowSeconds * 1000, now = this.now(), limit = this.cfg.globalQuota[cls];
    const { used, oldest } = this.store.quotaWindow(`global:${cls}`, now - windowMs);
    return { limit, used, now, windowMs, nextFreeAt: used >= limit && oldest !== null ? oldest + windowMs : null };
  }
  requireGlobal(cls: QuotaClass | "workspaces") {
    const b = this.globalBudget(cls);
    if (b.used < b.limit) return b;
    const s = this.cfg.quota.windowSeconds;
    const retryAfterSeconds = b.nextFreeAt === null ? s : Math.max(1, Math.ceil((b.nextFreeAt - b.now) / 1000));
    throw new RailError("quota_exceeded", `The host's budget for ${QUOTA_COUNTS[cls]}, over all workspaces together, is spent: ${b.limit} in any ${s === 3600 ? "hour" : `${s} seconds`}. Nothing was stored or started${b.limit ? `; the next one is allowed at ${new Date(b.now + retryAfterSeconds * 1000).toISOString()}` : ""}.`, 429, { scope: "global", class: cls, limit: b.limit, used: b.used, windowSeconds: s, retryAfterSeconds, nextFreeAt: b.nextFreeAt === null ? null : new Date(b.nextFreeAt).toISOString() });
  }
  spendGlobal(cls: QuotaClass | "workspaces") {
    const b = this.requireGlobal(cls);
    this.store.quotaAdd(`global:${cls}`, b.now, b.now - b.windowMs);
  }
  globalQuota(): QuotaView {
    return { windowSeconds: this.cfg.quota.windowSeconds, classes: (Object.keys(QUOTA_COUNTS) as (QuotaClass | "workspaces")[]).map((cls) => { const b = this.globalBudget(cls); return { class: cls, counts: QUOTA_COUNTS[cls], limit: b.limit, used: b.used, remaining: Math.max(0, b.limit - b.used), nextFreeAt: b.nextFreeAt === null ? null : new Date(b.nextFreeAt).toISOString() }; }) };
  }

  // ───────────────────────────── ephemeral chains (R7 D4) ─────────────────────────────
  /**
   * Runs `f` on a new Anvil of its own: listening only on a port browsers refuse and driven over a private socket, as the
   * shared chain is (F-14), a throwaway folder, no saved state. The chain is stopped and its folder deleted afterwards, whatever
   * happens. At most cfg.maxEphemeral run at once; more wait for a slot.
   */
  async ephemeral<T>(runId: string, f: (e: EphemeralChain) => Promise<T>): Promise<T> {
    while (this.#ephemeralActive >= this.cfg.maxEphemeral) await new Promise<void>((r) => this.#ephemeralWaiting.push(r));
    this.#ephemeralActive++;
    const dir = join(this.cfg.railDir, "ephemeral", runId.replace(/[^A-Za-z0-9-]/g, "").slice(0, 60));
    let anvil: Anvil | null = null;
    try {
      mkdirSync(dir, { recursive: true });
      // like the shared chain: a port browsers refuse (never one of the owner's), driven over a private socket (F-14)
      anvil = new Anvil({ bin: this.cfg.anvilBin, stateFile: join(dir, "never-written.hex"), pidFile: join(dir, "anvil.pid") });
      await anvil.start();
      const c = quickReceipts(new this.v.chain.Chain$(anvil.url, CHAIN_ID, FEES));
      return await f({ anvil, c, port: anvil.port, url: anvil.url, dir });
    } finally {
      await anvil?.stop().catch(() => {});
      rmSync(dir, { recursive: true, force: true });
      this.#ephemeralActive--;
      this.#ephemeralWaiting.shift()?.();
    }
  }
  /** An ephemeral Anvil left behind by a killed rail is stopped at the next start, recognised by its pid file and command line. */
  private reapEphemeral() {
    const root = join(this.cfg.railDir, "ephemeral");
    if (!existsSync(root)) return;
    for (const d of readdirSync(root)) {
      try {
        const pid = Number(readFileSync(join(root, d, "anvil.pid"), "utf8").trim());
        if (Number.isInteger(pid) && pid > 1 && /anvil/.test(execFileSync("ps", ["-p", String(pid), "-o", "command="]).toString())) process.kill(pid, "SIGKILL");
      } catch { /* not running */ }
      // and the private folder of its socket (chain/rail/anvil.ts socketFolder)
      try {
        const sock = String((JSON.parse(readFileSync(join(root, d, "anvil.endpoint.json"), "utf8")) as { socket?: string }).socket ?? "");
        if (/\/qed-chain-[A-Za-z0-9]{6}\/anvil\.ipc$/.test(sock)) rmSync(dirname(sock), { recursive: true, force: true });
      } catch { /* none */ }
      rmSync(join(root, d), { recursive: true, force: true });
    }
  }

  // ───────────────────────────── health ─────────────────────────────
  /**
   * R13 review fix F3: the co-signer signs the fixed self-test text with the baseline scope's active key; the deployed
   * image's isolation check recovers the signer and compares it with the co-signer's process (scripts/deploy/isolation-check.ts).
   */
  async cosignerSelfTest(): Promise<{ address: Address; signature: Hex; message: string; isolation: string; pid: number | null }> {
    this.requireReady();
    const r = (await this.cosigner.call(BASELINE_WORKSPACE, "selfTest", {})) as { address: Address; signature: Hex };
    return { ...r, message: COSIGNER_SELF_TEST, isolation: this.cosigner.isolation, pid: (this.cosigner as { pid?: number | null }).pid ?? null };
  }

  async health(): Promise<Health> {
    const anvilUp = this.anvil ? await this.anvil.alive() : false;
    let contracts = false;
    const probe = this.baselineAddresses ? [this.baselineAddresses.vault, this.baselineAddresses.exec] : this.market ? [this.market.lens, this.market.inr] : [];
    if (anvilUp && probe.length) {
      try {
        const codes = await Promise.all(probe.map((a) => this.anvil.rpc("eth_getCode", [a, "latest"], 1_500)));
        contracts = codes.every((x) => typeof x === "string" && x.length > 2);
      } catch { contracts = false; }
    }
    let store = false;
    try { this.store.meta("genesis"); store = true; } catch { store = false; }
    const cosigner = this.cosigner ? await this.cosigner.alive() : false;
    const ready = this.status === "ready" && anvilUp && contracts && store && cosigner && this.vendoredOk === true;
    return {
      status: ready ? "ok" : this.status === "starting" ? "starting" : "unavailable",
      ready,
      readiness: { rail: this.status, anvil: anvilUp, contracts, store, cosigner, vendored: this.vendoredOk, checkedAt: this.iso() },
      mode: this.cfg.mode,
      workspaces: this.workspaces.size,
      provisioned: store && this.baseline ? this.baseline.provisioned : false,
      network: this.networkLabel,
      versions: { node: process.version, anvil: this.anvil?.version ?? null, release: RELEASE_ID },
    };
  }

  /** Test seam (off unless QED_RAIL_ALLOW_FAULTS=1): QED_RAIL_FAULT="mid-provision" or "provision-recorded" kills the process there. */
  fault(name: string) {
    if (this.cfg.allowFaults && process.env.QED_RAIL_FAULT === name) process.kill(process.pid, "SIGKILL");
  }
  /** For tests and evidence: the SHA-256 of the master secret's file is never exposed; only whether it exists and its mode. */
  masterSecretFile = () => join(this.cfg.railDir, "master.key");
  static sha256 = (b: Buffer | string) => createHash("sha256").update(b).digest("hex");
}
