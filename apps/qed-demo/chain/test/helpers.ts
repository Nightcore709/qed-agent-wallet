/** Shared helpers for the rail's own tests. Every rail runs on its own port with its own throwaway data folder. */
import { randomUUID } from "node:crypto";
import { mkdirSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createRail, type Rail } from "../rail/index.ts";
import type { RailConfig } from "../rail/config.ts";
import type { Approval, Job, Proposal, ProposalKind } from "../types.ts";

export const CHAIN = resolve(fileURLToPath(new URL("..", import.meta.url)));
export const freshDir = (name: string) => {
  const dir = join(CHAIN, ".build", "test-data", `${name}-${randomUUID().slice(0, 8)}`);
  mkdirSync(dir, { recursive: true });
  return dir;
};
export const key = () => randomUUID();

/** What the backend would send after the authenticated owner confirmed exactly these terms. */
export const approve = (p: Proposal, over: Partial<Approval> = {}): Approval => ({ approvalId: `ap-${randomUUID()}`, docHash: `sha256:${"d".repeat(64)}`, termsHash: p.termsHash, confirmedAt: new Date().toISOString(), method: "test-owner", ...over });

export interface TestRail {
  rail: Rail;
  dir: string;
  /** propose → approve → execute → wait. Returns the finished job. */
  act(kind: ProposalKind, params?: Record<string, unknown>): Promise<Job>;
  /** Provision and sign mandate v1 (≤ 25 tUSD per conversion), as the release's sandbox starts. */
  ready(): Promise<void>;
  stop(opts?: { keep?: boolean }): Promise<void>;
}

export async function startRail(name: string, anvilPort: number, over: Partial<RailConfig> = {}): Promise<TestRail> {
  const dir = over.dataDir ?? freshDir(name);
  // Library tests host the co-signer in-process unless they ask otherwise (some of them sign as the co-signer to
  // play an attacker who stole its key). The service's default, exercised by the service-level tests, is a separate process.
  const rail = createRail({ dataDir: dir, anvilPort, economyAnvilPort: anvilPort + 500, cosigner: "in-process", ...over });
  await rail.start();
  const act = async (kind: ProposalKind, params: Record<string, unknown> = {}) => {
    const p = await rail.propose({ kind, params });
    const a = rail.execute(p.id, approve(p, { confirmedAt: new Date(rail.now()).toISOString() }), key());
    return rail.waitForJob(a.jobId);
  };
  return {
    rail, dir, act,
    ready: async () => {
      const prov = await act("provision");
      if (prov.status !== "done") throw new Error(`provision failed: ${prov.error}`);
      const m = await act("mandate", { maxPerPayment: "25" });
      if (m.status !== "done") throw new Error(`mandate failed: ${m.error}`);
    },
    stop: async (o = {}) => { await rail.stop(); if (!o.keep) rmSync(dir, { recursive: true, force: true }); },
  };
}

// ───────────── multi-tenant hosts (R7): workspaces owned by software passkeys ─────────────
import { createHost } from "../rail/index.ts";
import type { RailHost, Rail as WorkspaceRail } from "../rail/host.ts";
import { RP_ID_HASH, SoftwarePasskey, passkeyApproval } from "./passkey.ts";

export interface TestHost {
  host: RailHost;
  dir: string;
  /** Creates a workspace owned by `owners` (one passkey, or several with a threshold). */
  workspace(id: string, owners: SoftwarePasskey[], threshold?: number): Promise<WorkspaceRail>;
  /** propose → the passkeys sign every item of toSign → executeChecked → wait. */
  act(ws: WorkspaceRail, kind: ProposalKind, params: Record<string, unknown>, signers: SoftwarePasskey[]): Promise<Job>;
  stop(opts?: { keep?: boolean }): Promise<void>;
}

/** A multi-tenant host on its own ports and data folder, with the owner-account build chain/accounts/READY.json declares. */
export async function startHost(name: string, anvilPort: number, over: Partial<RailConfig> = {}): Promise<TestHost> {
  const dir = over.dataDir ?? freshDir(name);
  const host = createHost({ dataDir: dir, anvilPort, economyAnvilPort: anvilPort + 500, cosigner: "in-process", ownerAccountBuild: "declared", accountDelaySeconds: 60, accountRecoveryDelaySeconds: 60, ...over });
  await host.start();
  return {
    host, dir,
    workspace: async (id, owners, threshold) => {
      const owner = owners.length === 1 && !threshold ? owners[0].publicKey : { signers: owners.map((o) => o.publicKey), threshold: threshold ?? 1 };
      await host.createWorkspace({ workspaceId: id, owner, rpIdHash: RP_ID_HASH });
      return host.workspace(id)!;
    },
    act: async (ws, kind, params, signers) => {
      const p = await ws.propose({ kind, params });
      const a = await ws.executeChecked(p.id, passkeyApproval(p, signers, ws.now()), key());
      return ws.waitForJob(a.jobId);
    },
    stop: async (o = {}) => { await host.stop(); if (!o.keep) rmSync(dir, { recursive: true, force: true }); },
  };
}
