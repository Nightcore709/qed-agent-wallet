/**
 * Composition of the rail.
 *
 *   createHost(cfg)   the multi-tenant host (default mode): one shared chain, workspaces created with POST /workspaces
 *                     (RailHost.createWorkspace), each owned by a passkey account the service cannot satisfy.
 *   createRail(cfg)   the baseline-parity host and its one workspace "baseline" with the release's development owner,
 *                     for the baseline parity tests only. Returns that workspace; its start() and stop() start and stop
 *                     the host.
 */
import type { RailConfig } from "./config.ts";
import { BASELINE_WORKSPACE } from "./config.ts";
import { RailHost, composeWorkspace, type Rail } from "./host.ts";
import { RailService } from "./service.ts";

export type { Rail } from "./host.ts";
export { RailHost, composeWorkspace } from "./host.ts";

export function createRail(cfg: Partial<RailConfig> = {}): Rail {
  const host = new RailHost({ ...cfg, mode: "baseline-parity" });
  const rail = composeWorkspace(new RailService(host, BASELINE_WORKSPACE));
  host.baseline = rail;
  return rail;
}

export function createHost(cfg: Partial<RailConfig> = {}): RailHost {
  return new RailHost({ ...cfg, mode: cfg.mode ?? "multi-tenant" });
}
