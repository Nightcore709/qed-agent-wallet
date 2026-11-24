/** Where the rail keeps its data and how it is bounded. Everything is local; nothing here names a remote host. */
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const CHAIN_DIR = resolve(fileURLToPath(new URL("..", import.meta.url)));
export const CHAIN_ID = 31337;
export const RELEASE_ID = "qed-20261023-health-gate-v3";

/**
 * How the host runs (R7, docs/r7/00-ARCHITECTURE-DECISIONS.md D1, D3, D4):
 *   multi-tenant     the default. One shared chain holds the shared test market; every workspace is created through
 *                    POST /workspaces with its own passkey owner account, vault set, keys and store. The service holds
 *                    no key that can act as an owner.
 *   baseline-parity  ONLY for the baseline parity tests: one implicit workspace "baseline" with the release's sandbox
 *                    deployment and the release's DEVELOPMENT owner key, held by this process (RISK-040). Labelled as
 *                    such in every state view. POST /workspaces is refused in this mode.
 */
export type HostMode = "multi-tenant" | "baseline-parity";
export const BASELINE_WORKSPACE = "baseline";

/** The opening grant a new workspace receives from the host's faucet, in raw units of valueless test tokens. */
export interface FaucetGrant {
  /** tINR (2 decimals, paise) into the workspace's treasury vault. */
  vaultINR: bigint;
  /** tINR into the owner account, so that a deposit has something to deposit. */
  ownerINR: bigint;
}

export interface RailConfig {
  mode: HostMode;
  /** apps/qed-demo/data by default. rail.db and rail.token live directly in it; everything else under rail/. */
  dataDir: string;
  dbPath: string;
  /** Records, Anvil state, the co-signer's key file and scripted-run output. */
  railDir: string;
  anvilBin: string;
  /**
   * Where a shared chain started before R13 listened (8546 by default). The chain no longer listens there: it takes a port
   * browsers refuse and is driven over a private socket (chain-socket.ts, F-14). Kept only to recognise and stop such a
   * chain left running.
   */
  anvilPort: number;
  /**
   * Before R13, the port of the second, short-lived Anvil of a scripted economy. That chain now takes a port browsers
   * refuse, chosen when the run starts (economies.ts); the setting is still read so existing configurations parse.
   */
  economyAnvilPort: number;
  /** Root of the vendored release tree whose modules are loaded. */
  vendorRoot: string;
  /** Every transaction is refused while the chain is ahead of the wall clock by more than this. */
  maxClockLeadSeconds: number;
  /** Heartbeat period, and the wall-clock silence between two heartbeats that counts as a gap (machine sleep, stall). */
  heartbeatMs: number;
  gapSeconds: number;
  proposalTtlMs: number;
  /** At most this many accepted operations may be running or waiting for the single writer; one more is refused (429 busy). */
  maxQueued: number;
  /**
   * The rail's own budget in any rolling window (baseline F-069): proposals prepared, operations accepted, scripted
   * economies started. Zero allows none. Defaults: 240, 240 and 4 an hour (the release allowed four scripted runs an
   * hour per connection; 240 is the wallet backend's own hourly limit per owner, so the rail's budget is a backstop).
   */
  quota: { windowSeconds: number; proposals: number; operations: number; economies: number };
  /**
   * The host's budget over all workspaces together, in the same rolling window, plus workspaces created. A request
   * must fit both its workspace's budget and this one. Defaults: 2400 proposals, 2400 operations, 16 economies and
   * 60 workspaces an hour.
   */
  globalQuota: { proposals: number; operations: number; economies: number; workspaces: number };
  /** At most this many shared-chain operations of all workspaces may wait for the single writer (429 busy beyond). */
  maxQueuedGlobal: number;
  /** At most this many ephemeral chains (Security Lab attacks, scenarios) may run at once on this machine. */
  maxEphemeral: number;
  /**
   * R7-036: a job is reported done only once each of its own transactions on the shared chain has this many confirmations
   * (the block holding it counts as one). Default 2: the depth the household's books (server/chain-books.ts) and the
   * authority budget (rail/authority-ledger.ts) use for this chain (shared/instrument.ts). QED_RAIL_CONFIRMATIONS, 1 to 64.
   * Until then the job is "confirming"; a job whose transaction a reorganisation replaces first is "reorged", never done.
   */
  confirmations: number;
  /**
   * Anvil mines a block only for a transaction, so on a quiet local chain a confirmation would wait for someone else's
   * transaction. On (default): the service mines the empty blocks a confirmation needs, never taking the chain's clock more
   * than a second ahead of the wall clock (otherwise it waits for the next heartbeat). Off (QED_RAIL_CONFIRM_MINE=0): a
   * job waits for the chain's own next blocks.
   */
  confirmMining: boolean;
  /** Opening grant for each new workspace (recorded in its store and the host's). */
  faucet: FaucetGrant;
  /** Each new workspace's treasury vault daily cap, in paise (default 10,000.00 tINR). */
  workspaceDailyCapINR: bigint;
  /**
   * Check C12 of every workspace's co-signer (the baseline-parity workspace always keeps the release's engine and C12):
   * "d7" (default), the authority budget of R7 decision D7 (rail/authority-ledger.ts); "release", the release's earned
   * allowance in the vault asset's units (decision D-A), as before D7 was built. QED_RAIL_AUTHORITY.
   */
  authority: "d7" | "release";
  /**
   * The D7 reference band of tUSD in tINR: half-width around the test market's genesis rate, in basis points
   * (default 50: 84 ± 0.5%), and how far the venues' mid may lie outside it before conversions are refused (default 0:
   * it must lie inside). QED_RAIL_AUTHORITY_BAND_BPS, QED_RAIL_AUTHORITY_DIVERGENCE_BPS.
   */
  authorityBandBps: number;
  authorityDivergenceBps: number;
  /**
   * K1 (rail/earned-authority.ts): earned authority counts at most `perWindow` raw units of tINR in any `windowSeconds`
   * of chain time, and at most `perPayer` from any one payer address (default 1,000.00 and 250.00 tINR in any 30 days).
   * QED_RAIL_EARNED_WINDOW_S, QED_RAIL_EARNED_CAP_PAISE, QED_RAIL_EARNED_CAP_PER_PAYER_PAISE.
   */
  authorityEarnedCap: { windowSeconds: number; perWindow: bigint; perPayer: bigint };
  /**
   * The shared test market's keeper (rail/keeper.ts; experiments/r8/D7-validation remedy R2): on each heartbeat, under
   * the writer, every venue more than this many basis points from the price it was deployed at is traded back to it.
   * 0 (default) turns it off. QED_RAIL_KEEPER_BPS, 0 to 500; multi-tenant hosts only.
   */
  keeperBps: number;
  /** Delays of a new owner account: protection-reducing changes and recovery (seconds; default 72 hours, R7 D2). */
  accountDelaySeconds: number;
  accountRecoveryDelaySeconds: number;
  /**
   * The owner-account build: "declared" (default) uses chain/accounts only once its README or HANDOFF declares
   * QEDOwnerAccount ready; "unreviewed" uses the current build without that declaration, labelled so in every view.
   */
  ownerAccountBuild: "declared" | "unreviewed";
  /**
   * The local refutation bounties (rail/bounties.ts; R11 section 9). `enabled`: deploy the bounty board and the two
   * original bounties on a multi-tenant chain (QED_RAIL_BOUNTIES, "0" turns it off). `controls`: also open the release's
   * positive controls, whose judges can be refuted (QED_RAIL_BOUNTY_CONTROLS=1; TESTS ONLY, labelled in every view).
   * `auto`: reveal and settle a workspace's claims on the heartbeat (QED_RAIL_BOUNTY_AUTO, "0" turns it off). Periods
   * in seconds, fixed for each bounty when it is opened: QED_RAIL_BOUNTY_REVEAL_DELAY_S (1 to 86400, default 60),
   * QED_RAIL_BOUNTY_REVEAL_WINDOW_S (60 to 31536000, default 86400), QED_RAIL_BOUNTY_CONTEST_S (1 to 86400, default 300).
   */
  bounty: { enabled: boolean; controls: boolean; auto: boolean; revealDelaySeconds: number; revealWindowSeconds: number; contestSeconds: number };
  cosigner: "process" | "in-process";
  zk: boolean;
  /** Test seams: wall clock in milliseconds and a monotonic clock in milliseconds. */
  wallClock: () => number;
  monoClock: () => number;
  /** Test seam: named fault points (see rail/service.ts → fault). Ignored unless allowFaults is true. */
  allowFaults: boolean;
  log: (line: string) => void;
}

/** A budget setting must be a whole number: a typing mistake stops the rail instead of switching a limit off. */
function quotaSetting(name: string, fallback: number, min: number): number {
  const v = process.env[name];
  if (v === undefined) return fallback;
  if (!/^\d{1,7}$/.test(v)) throw new Error(`${name} must be a whole number (got "${v.slice(0, 20)}").`);
  if (Number(v) < min) throw new Error(`${name} must be at least ${min}.`);
  return Number(v);
}
function checkedQuota(q: RailConfig["quota"]): RailConfig["quota"] {
  const whole = (x: unknown, min: number) => Number.isInteger(x) && (x as number) >= min && (x as number) <= 9_999_999;
  if (!q || !whole(q.windowSeconds, 1) || !whole(q.proposals, 0) || !whole(q.operations, 0) || !whole(q.economies, 0)) throw new Error("The quota setting must hold whole numbers: windowSeconds of at least 1; proposals, operations and economies of at least 0.");
  return { windowSeconds: q.windowSeconds, proposals: q.proposals, operations: q.operations, economies: q.economies };
}

function modeSetting(): HostMode {
  const v = process.env.QED_RAIL_MODE;
  if (v === undefined || v === "multi-tenant") return "multi-tenant";
  if (v === "baseline-parity") return "baseline-parity";
  throw new Error(`QED_RAIL_MODE must be "multi-tenant" or "baseline-parity" (got "${v.slice(0, 30)}").`);
}
function amountSetting(name: string, fallback: bigint): bigint {
  const v = process.env[name];
  if (v === undefined) return fallback;
  if (!/^\d{1,18}$/.test(v)) throw new Error(`${name} must be a whole number of raw units (got "${v.slice(0, 20)}").`);
  return BigInt(v);
}
function authoritySetting(): "d7" | "release" {
  const v = process.env.QED_RAIL_AUTHORITY;
  if (v === undefined || v === "d7") return "d7";
  if (v === "release") return "release";
  throw new Error(`QED_RAIL_AUTHORITY must be "d7" or "release" (got "${v.slice(0, 30)}").`);
}
function bpsSetting(name: string, value: number | undefined, fallback: number, min: number, max: number): number {
  const v = value ?? (process.env[name] === undefined ? fallback : /^\d{1,4}$/.test(process.env[name]!) ? Number(process.env[name]) : NaN);
  if (!Number.isInteger(v) || v < min || v > max) throw new Error(`${name} must be a whole number of basis points from ${min} to ${max}.`);
  return v;
}
function secondsSetting(name: string, fallback: number): number {
  const v = process.env[name];
  if (v === undefined) return fallback;
  if (!/^\d{2,8}$/.test(v) || Number(v) < 60 || Number(v) > 30 * 86_400) throw new Error(`${name} must be whole seconds from 60 to 2592000 (the owner account's bounds).`);
  return Number(v);
}
function confirmationsSetting(): number {
  const v = process.env.QED_RAIL_CONFIRMATIONS;
  if (v === undefined) return 2;
  if (!/^\d{1,2}$/.test(v) || Number(v) < 1 || Number(v) > 64) throw new Error(`QED_RAIL_CONFIRMATIONS must be a whole number of blocks from 1 to 64 (got "${v.slice(0, 20)}").`);
  return Number(v);
}
function earnedCapSetting(): RailConfig["authorityEarnedCap"] {
  const w = process.env.QED_RAIL_EARNED_WINDOW_S;
  if (w !== undefined && (!/^\d{1,9}$/.test(w) || Number(w) < 3_600)) throw new Error(`QED_RAIL_EARNED_WINDOW_S must be whole seconds, at least 3600 (got "${w.slice(0, 20)}").`);
  // in raw units of tINR (2 decimals): 1,000.00 and 250.00 tINR
  return { windowSeconds: w === undefined ? 30 * 86_400 : Number(w), perWindow: amountSetting("QED_RAIL_EARNED_CAP_PAISE", 100_000n), perPayer: amountSetting("QED_RAIL_EARNED_CAP_PER_PAYER_PAISE", 25_000n) };
}
function bountySetting(): RailConfig["bounty"] {
  const flag = (name: string, fallback: boolean) => {
    const v = process.env[name];
    if (v === undefined) return fallback;
    if (v !== "0" && v !== "1") throw new Error(`${name} must be "0" or "1" (got "${v.slice(0, 20)}").`);
    return v === "1";
  };
  const secs = (name: string, fallback: number, min: number, max: number) => {
    const v = process.env[name];
    if (v === undefined) return fallback;
    if (!/^\d{1,8}$/.test(v) || Number(v) < min || Number(v) > max) throw new Error(`${name} must be whole seconds from ${min} to ${max}.`);
    return Number(v);
  };
  return {
    enabled: flag("QED_RAIL_BOUNTIES", true),
    controls: flag("QED_RAIL_BOUNTY_CONTROLS", false),
    auto: flag("QED_RAIL_BOUNTY_AUTO", true),
    revealDelaySeconds: secs("QED_RAIL_BOUNTY_REVEAL_DELAY_S", 60, 1, 86_400),
    revealWindowSeconds: secs("QED_RAIL_BOUNTY_REVEAL_WINDOW_S", 86_400, 60, 31_536_000),
    contestSeconds: secs("QED_RAIL_BOUNTY_CONTEST_S", 300, 1, 86_400),
  };
}
function checkedGlobal(q: RailConfig["globalQuota"]): RailConfig["globalQuota"] {
  const whole = (x: unknown) => Number.isInteger(x) && (x as number) >= 0 && (x as number) <= 9_999_999;
  if (!q || !whole(q.proposals) || !whole(q.operations) || !whole(q.economies) || !whole(q.workspaces)) throw new Error("The global quota setting must hold whole numbers of at least 0: proposals, operations, economies and workspaces.");
  return { proposals: q.proposals, operations: q.operations, economies: q.economies, workspaces: q.workspaces };
}

export function defaultConfig(over: Partial<RailConfig> = {}): RailConfig {
  const dataDir = resolve(over.dataDir ?? process.env.QED_RAIL_DATA ?? join(CHAIN_DIR, "..", "data"));
  const build = over.ownerAccountBuild ?? (process.env.QED_RAIL_OWNER_ACCOUNT_BUILD === undefined ? "declared" : process.env.QED_RAIL_OWNER_ACCOUNT_BUILD);
  if (build !== "declared" && build !== "unreviewed") throw new Error('QED_RAIL_OWNER_ACCOUNT_BUILD must be "declared" or "unreviewed".');
  return {
    mode: over.mode ?? modeSetting(),
    dataDir,
    dbPath: over.dbPath ?? join(dataDir, "rail.db"),
    railDir: over.railDir ?? join(dataDir, "rail"),
    anvilBin: over.anvilBin ?? process.env.QED_RAIL_ANVIL ?? join(homedir(), ".foundry", "bin", "anvil"),
    anvilPort: over.anvilPort ?? Number(process.env.QED_RAIL_ANVIL_PORT ?? 8546),
    economyAnvilPort: over.economyAnvilPort ?? Number(process.env.QED_RAIL_ECONOMY_ANVIL_PORT ?? 8547),
    // With the optional tier the rail loads the release from an assembled copy that also holds the GPL-3.0 files.
    vendorRoot: over.vendorRoot ?? ((over.zk ?? process.env.QED_RAIL_ZK === "1") ? join(CHAIN_DIR, "zk-optional", ".build", "tree") : join(CHAIN_DIR, "vendor")),
    maxClockLeadSeconds: over.maxClockLeadSeconds ?? Number(process.env.QED_RAIL_MAX_CLOCK_LEAD_S ?? 5),
    heartbeatMs: over.heartbeatMs ?? Number(process.env.QED_RAIL_HEARTBEAT_MS ?? 2_000),
    gapSeconds: over.gapSeconds ?? Number(process.env.QED_RAIL_GAP_S ?? 15),
    proposalTtlMs: over.proposalTtlMs ?? 10 * 60_000,
    maxQueued: over.maxQueued ?? 16,
    quota: checkedQuota(over.quota ?? { windowSeconds: quotaSetting("QED_RAIL_QUOTA_WINDOW_S", 3600, 1), proposals: quotaSetting("QED_RAIL_QUOTA_PROPOSALS", 240, 0), operations: quotaSetting("QED_RAIL_QUOTA_OPERATIONS", 240, 0), economies: quotaSetting("QED_RAIL_QUOTA_ECONOMIES", 4, 0) }),
    globalQuota: checkedGlobal(over.globalQuota ?? { proposals: quotaSetting("QED_RAIL_GLOBAL_QUOTA_PROPOSALS", 2400, 0), operations: quotaSetting("QED_RAIL_GLOBAL_QUOTA_OPERATIONS", 2400, 0), economies: quotaSetting("QED_RAIL_GLOBAL_QUOTA_ECONOMIES", 16, 0), workspaces: quotaSetting("QED_RAIL_GLOBAL_QUOTA_WORKSPACES", 60, 0) }),
    maxQueuedGlobal: over.maxQueuedGlobal ?? 64,
    maxEphemeral: over.maxEphemeral ?? quotaSetting("QED_RAIL_MAX_EPHEMERAL", 2, 1),
    confirmations: over.confirmations ?? confirmationsSetting(),
    confirmMining: over.confirmMining ?? process.env.QED_RAIL_CONFIRM_MINE !== "0",
    faucet: over.faucet ?? { vaultINR: amountSetting("QED_RAIL_FAUCET_VAULT_PAISE", 10_000_000n), ownerINR: amountSetting("QED_RAIL_FAUCET_OWNER_PAISE", 1_000_000n) },
    workspaceDailyCapINR: over.workspaceDailyCapINR ?? amountSetting("QED_RAIL_WORKSPACE_DAILY_CAP_PAISE", 1_000_000n),
    authority: over.authority ?? authoritySetting(),
    authorityBandBps: bpsSetting("QED_RAIL_AUTHORITY_BAND_BPS", over.authorityBandBps, 50, 1, 2000),
    authorityDivergenceBps: bpsSetting("QED_RAIL_AUTHORITY_DIVERGENCE_BPS", over.authorityDivergenceBps, 0, 0, 2000),
    authorityEarnedCap: over.authorityEarnedCap ?? earnedCapSetting(),
    keeperBps: bpsSetting("QED_RAIL_KEEPER_BPS", over.keeperBps, 0, 0, 500),
    accountDelaySeconds: over.accountDelaySeconds ?? secondsSetting("QED_RAIL_ACCOUNT_DELAY_S", 72 * 3600),
    accountRecoveryDelaySeconds: over.accountRecoveryDelaySeconds ?? secondsSetting("QED_RAIL_ACCOUNT_RECOVERY_DELAY_S", 72 * 3600),
    ownerAccountBuild: build,
    bounty: over.bounty ?? bountySetting(),
    cosigner: over.cosigner ?? (process.env.QED_RAIL_COSIGNER === "in-process" ? "in-process" : "process"),
    zk: over.zk ?? process.env.QED_RAIL_ZK === "1",
    wallClock: over.wallClock ?? (() => Date.now()),
    monoClock: over.monoClock ?? (() => performance.now()),
    allowFaults: over.allowFaults ?? process.env.QED_RAIL_ALLOW_FAULTS === "1",
    log: over.log ?? (() => {}),
  };
}
