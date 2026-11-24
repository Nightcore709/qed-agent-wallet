/**
 * The single place where release code is loaded. Every module comes from one vendored tree (vendor/ by default, or
 * the assembled tree that also holds the zk-optional tier), so the whole release module graph is consistent.
 *
 * Loader: the release's TypeScript imports its siblings with ".js" specifiers and uses constructor parameter
 * properties. Node 26 strips types but supports neither, so these modules need tsx (4.19.2, the release's own
 * pinned loader). serve.ts registers it before anything here is imported; tests run with `node --import tsx`.
 */
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { CHAIN_DIR } from "./config.ts";

export interface Vendored {
  root: string;
  abi: typeof import("../vendor/agent/src/abi/contracts.ts");
  chain: typeof import("../vendor/agent/src/chain.ts");
  trader: typeof import("../vendor/agent/src/roles/trader.ts");
  cosigner: typeof import("../vendor/agent/src/roles/cosigner.ts");
  treasury: typeof import("../vendor/agent/src/roles/treasury.ts");
  eip712: typeof import("../vendor/agent/src/protocol/eip712.ts");
  records: typeof import("../vendor/agent/src/protocol/records.ts");
  execution: typeof import("../vendor/agent/src/engine/execution.ts");
  scenario: typeof import("../vendor/agent/src/engine/executionScenario.ts");
  economics: typeof import("../vendor/agent/src/engine/economics.ts");
  guard: typeof import("../vendor/agent/src/brain/guard.ts");
  offline: typeof import("../vendor/agent/src/brain/offline.ts");
  clock: typeof import("../vendor/agent/src/sandboxClock.ts");
  amounts: typeof import("../vendor/agent/scripts/amount-lexing.mjs");
  capabilities: typeof import("../vendor/agent/scripts/capabilities.mjs");
  /** The release's certifying solver for the long-only minimum-variance portfolio, and its bit-exact checker. */
  minvar: typeof import("../vendor/agent/src/engine/minvar.ts");
  /** The release's spec and solution codecs (they must match MinVarianceVerifier) and its illustrative risk model. */
  riskModel: typeof import("../vendor/agent/src/engine/riskModel.ts");
  /** workbench.ts is typed by hand: its dynamic import of the optional prover cannot be type-checked in the default tier. */
  workbench: { runWorkbench: (c: unknown, name: string, raw: unknown, emit: (s: unknown) => void, market?: { exec: string; usd: string; eur: string }) => Promise<any> };
}

export async function loadVendored(root: string): Promise<Vendored> {
  const load = (rel: string) => import(pathToFileURL(join(root, rel)).href);
  const [abi, chain, trader, cosigner, treasury, eip712, records, execution, scenario, economics, guard, offline, clock, amounts, capabilities, workbench, minvar, riskModel] = await Promise.all([
    load("agent/src/abi/contracts.ts"), load("agent/src/chain.ts"), load("agent/src/roles/trader.ts"), load("agent/src/roles/cosigner.ts"), load("agent/src/roles/treasury.ts"),
    load("agent/src/protocol/eip712.ts"), load("agent/src/protocol/records.ts"), load("agent/src/engine/execution.ts"), load("agent/src/engine/executionScenario.ts"),
    load("agent/src/engine/economics.ts"), load("agent/src/brain/guard.ts"), load("agent/src/brain/offline.ts"), load("agent/src/sandboxClock.ts"),
    load("agent/scripts/amount-lexing.mjs"), load("agent/scripts/capabilities.mjs"), load("agent/src/workbench.ts"),
    load("agent/src/engine/minvar.ts"), load("agent/src/engine/riskModel.ts"),
  ]);
  return { root, abi, chain, trader, cosigner, treasury, eip712, records, execution, scenario, economics, guard, offline, clock, amounts, capabilities, workbench, minvar, riskModel };
}

/**
 * Checks every vendored file under `root` against the recorded SHA-256 (VENDORED.json, and the optional tier's
 * manifest when its files are part of the tree). The rail does not load release code that fails this check.
 */
export function verifyVendoredTree(root: string, withZk: boolean): { ok: boolean; files: number; problems: string[] } {
  const manifests = [join(CHAIN_DIR, "VENDORED.json"), ...(withZk ? [join(CHAIN_DIR, "zk-optional", "VENDORED-ZK.json")] : [])];
  const problems: string[] = [];
  let files = 0;
  for (const m of manifests) {
    for (const e of JSON.parse(readFileSync(m, "utf8")).files as { source: string; sha256: string }[]) {
      const path = join(root, e.source);
      files++;
      if (!existsSync(path)) problems.push(`${e.source} (missing)`);
      else if (createHash("sha256").update(readFileSync(path)).digest("hex") !== e.sha256) problems.push(e.source);
    }
  }
  return { ok: problems.length === 0, files, problems };
}
