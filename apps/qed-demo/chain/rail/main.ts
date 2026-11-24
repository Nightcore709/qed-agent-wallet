/**
 * Process entry of the loopback service (started by serve.ts once the loader for the vendored code is registered).
 *
 * Environment (all optional):
 *   QED_RAIL_MODE              "multi-tenant" (default: workspaces created with POST /workspaces, passkey owners) or
 *                              "baseline-parity" (one workspace with the release's development owner; parity tests only)
 *   QED_RAIL_OWNER_ACCOUNT_BUILD  "declared" (default: the owner-account build is used only when chain/accounts/READY.json
 *                              declares it ready with a matching hash) or "unreviewed" (tests only; labelled everywhere)
 *   QED_RAIL_GLOBAL_QUOTA_PROPOSALS, _OPERATIONS, _ECONOMIES, _WORKSPACES   the host's budget over all workspaces
 *                              (2400, 2400, 16, 60 in the rolling window)
 *   QED_RAIL_FAUCET_VAULT_PAISE, QED_RAIL_FAUCET_OWNER_PAISE   each new workspace's opening grant of test tINR
 *                              (10000000 = 1,00,000.00 tINR into the vault; 1000000 into the owner account)
 *   QED_RAIL_WORKSPACE_DAILY_CAP_PAISE   each new workspace vault's daily cap (1000000 = 10,000.00 tINR)
 *   QED_RAIL_ACCOUNT_DELAY_S, QED_RAIL_ACCOUNT_RECOVERY_DELAY_S   the owner account's delays (259200 = 72 hours each)
 *   QED_RAIL_MAX_EPHEMERAL     ephemeral chains running at once for the Security Lab and scenarios (2)
 *   QED_RAIL_PORT              HTTP port on 127.0.0.1 (default 5176)
 *   QED_RAIL_DATA              data directory (default apps/qed-demo/data): rail.db, rail.token, rail/
 *   QED_RAIL_ANVIL_PORT        where a chain started before R13 listened (default 8546), only to stop one left running:
 *                              the chain now listens on a port browsers refuse and is reached over a private socket (F-14)
 *   QED_RAIL_ANVIL             path of the anvil binary (default ~/.foundry/bin/anvil)
 *   QED_RAIL_MAX_CLOCK_LEAD_S  refuse transactions while the chain leads the wall clock by more (default 5)
 *   QED_RAIL_HEARTBEAT_MS, QED_RAIL_GAP_S   heartbeat period and the silence that counts as a gap (2000, 15)
 *   QED_RAIL_COSIGNER          "process" or "in-process"
 *   QED_RAIL_ZK                "1" to offer the optional zero-knowledge scenario (see zk-optional/README.md)
 *   QED_RAIL_BOUNTIES          "0" to leave out the local bounty board (rail/bounties.ts; on by default, multi-tenant only)
 *   QED_RAIL_BOUNTY_CONTROLS   "1" (TESTS ONLY) to also open the release's positive controls as claimable bounties
 *   QED_RAIL_BOUNTY_AUTO       "0" to stop the heartbeat revealing and settling workspaces' bounty claims
 *   QED_RAIL_BOUNTY_REVEAL_DELAY_S, _REVEAL_WINDOW_S, _CONTEST_S   a new bounty's periods (60, 86400, 300)
 *   QED_RAIL_QUOTA_PROPOSALS, QED_RAIL_QUOTA_OPERATIONS, QED_RAIL_QUOTA_ECONOMIES
 *                              the rail's own budget in any rolling window: proposals prepared (240), operations
 *                              accepted (240), scripted economies started (4). Zero allows none. Whole numbers only:
 *                              anything else stops the rail at start (rail/config.ts)
 *   QED_RAIL_QUOTA_WINDOW_S    length of that window in seconds (default 3600)
 */
import { randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { defaultConfig } from "./config.ts";
import { createRailServer } from "./http.ts";
import { createHost, createRail } from "./index.ts";
import { publicError } from "./service.ts";

/** The bearer token of the one client. Created with mode 600 on first start; never printed. */
export function loadOrCreateToken(path: string): string {
  if (!existsSync(path)) {
    writeFileSync(path, randomBytes(32).toString("base64url") + "\n", { mode: 0o600, flag: "wx" });
  } else if ((statSync(path).mode & 0o077) !== 0) {
    chmodSync(path, 0o600);
  }
  const token = readFileSync(path, "utf8").trim();
  if (token.length < 32) throw new Error(`The token in ${path} is too short; delete the file to have a new one created.`);
  return token;
}

export async function main(): Promise<void> {
  const cfg = defaultConfig({ log: (line) => console.log(`[rail] ${line}`) });
  const port = Number(process.env.QED_RAIL_PORT ?? 5176);
  mkdirSync(cfg.railDir, { recursive: true });
  const tokenPath = join(cfg.dataDir, "rail.token");
  const token = loadOrCreateToken(tokenPath);
  // The release's scenarios write their evidence relative to the working directory; keep that inside the data
  // folder so that nothing is ever written into vendor/.
  process.chdir(cfg.railDir);
  const host = cfg.mode === "baseline-parity" ? createRail(cfg).host : createHost(cfg);
  const server = createRailServer(host, { token, port });
  await new Promise<void>((ok, fail) => { server.once("error", fail); server.listen(port, "127.0.0.1", () => ok()); });
  console.log(`QED chain rail on http://127.0.0.1:${port} (loopback only, ${cfg.mode}). Bearer token file: ${tokenPath} (mode 600).`);
  console.log(cfg.mode === "baseline-parity" ? "Local Anvil chain 31337, valueless test tokens, the release's development keys (baseline parity only). /health is 503 until the chain and contracts answer." : "Local Anvil chain 31337, valueless test tokens; workspaces are created with POST /workspaces and owned by passkey accounts. /health is 503 until the chain and contracts answer.");
  host.start().then(
    () => console.log(`[rail] ready${host.restoredFromState ? " (chain state restored)" : " (fresh chain deployed)"}`),
    (e) => console.error(`[rail] failed to start: ${publicError(e)}`),
  );
  let closing = false;
  const shutdown = (signal: string) => {
    if (closing) return;
    closing = true;
    console.log(`[rail] ${signal}: stopping`);
    const force = setTimeout(() => process.exit(1), 8_000);
    force.unref();
    server.close();
    server.closeAllConnections?.();
    host.stop().catch(() => {}).finally(() => process.exit(0));
  };
  for (const s of ["SIGINT", "SIGTERM"] as const) process.on(s, () => shutdown(s));
  process.on("unhandledRejection", (e) => console.error(`[rail] unhandled: ${publicError(e)}`));
}
