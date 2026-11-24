/**
 * The four scripted economies (baseline WF-7 to WF-11): the release's own scripts, unmodified, each on a fresh
 * Anvil chain of its own, one at a time, with their evidence manifest turned into a step stream.
 *
 * What differs from the release's launcher (demo-server.mjs → startRun):
 *   - the child gets an explicit allowlist of environment variables instead of the server's whole environment
 *     (baseline W-30); no model credential ever reaches it and QED_OFFLINE=1 is set, so no external call is made;
 *   - the script's working directory is a throwaway folder of symbolic links to the vendored tree, so its output
 *     (deployments/, evidence) never lands in vendor/;
 *   - the run is a durable job like every other operation, and it does not hold the rail's single writer, because it
 *     never touches the rail's own chain;
 *   - honeypot.json, which the `economy` script writes with the development honeypot keys in clear, is removed from
 *     the run's output once the run ends (the keys are derivable from public strings and valueless; owner decision
 *     F-060 is about the published Sepolia keys, which are not in this workspace).
 */
import { spawn, execFileSync, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Accepted, OpResult, StepStatus } from "../types.ts";
import { portFree, socketFolder } from "./anvil.ts";
import { BROWSER_BLOCKED_PORTS, startChainGuard } from "./chain-socket.ts";
import { CHAIN_DIR } from "./config.ts";
import { RailError, type RailService } from "./service.ts";
import { withoutCaps } from "./caps.ts";

export const ECONOMIES = {
  execution: { script: "agent/scripts/execute.ts", bundled: "evidence/ethereum-sepolia/execution/manifest.json", title: "The complete best-execution economy", needsZk: false },
  economy: { script: "agent/scripts/live.ts", bundled: "evidence/ethereum-sepolia/manifest.json", title: "Paid work, escrow and portfolio optimality", needsZk: false },
  clearing: { script: "agent/scripts/clearing.ts", bundled: "evidence/ethereum-sepolia/clearing/manifest.json", title: "Certified multilateral clearing", needsZk: false },
  privacy: { script: "agent/scripts/private.ts", bundled: "evidence/ethereum-sepolia/private/manifest.json", title: "Zero-knowledge optimality", needsZk: true },
} as const;
export type EconomyName = keyof typeof ECONOMIES;
const DEFAULT_INSTRUCTION = "Move 20 tUSD of this month's revenue into the euro reserve — CloudCo's euro invoices are due next week.";

const shq = (s: string) => `'${s.replace(/'/g, "'\\''")}'`;

export function installEconomies(rail: RailService, zkAvailable: () => boolean) {
  rail.unqueued.add("economy");
  // One scripted economy at a time on the whole host (the `economy` script binds fixed ports 7701 to 7703); the run's
  // record and output belong to the workspace that started it.
  const host = rail.host;
  const runnerPidFile = () => join(rail.cfg.railDir, "runs", "runner.pid");
  const outRoot = () => (rail.isBaseline ? join(rail.cfg.railDir, "runs") : join(rail.cfg.railDir, "workspaces", rail.id, "runs"));

  /** The release's own rules for a run request (demo-server.mjs → validateRun), in local mode. */
  const validate = (input: any): { scenario: EconomyName; instruction: string; impact: number } => {
    if (!input || typeof input !== "object" || Array.isArray(input)) throw new RailError("invalid_request", "Invalid request.", 422);
    if (Object.keys(input).some((k) => !["scenario", "instruction", "impact"].includes(k))) throw new RailError("invalid_request", "A run takes { scenario, instruction?, impact? }.", 422);
    if (!Object.hasOwn(ECONOMIES, input.scenario)) throw new RailError("unsupported_scenario", "Select a supported demonstration.", 422);
    const scenario = input.scenario as EconomyName;
    if (ECONOMIES[scenario].needsZk && !zkAvailable()) throw new RailError("zk_optional_disabled", "The privacy economy needs the optional GPL-3.0 tier, which is off by default pending owner decision F-052. See zk-optional/README.md.", 409);
    let instruction = "";
    if (scenario === "execution") {
      const s = input.instruction === undefined ? DEFAULT_INSTRUCTION : input.instruction;
      if (typeof s !== "string" || s.length > 240 || s.length < 12) throw new RailError("invalid_instruction", "Enter a concise financial instruction (12–240 characters).", 422);
      if (/(?:ignore|override|bypass|disable|secret|private key|withdraw to|send to|unapproved|change (?:the )?(?:owner|limit|payee))/i.test(s)) throw new RailError("escalation_refused", "Policy-escalation request refused. Only the owner can change a signed mandate; no transaction was submitted.", 422);
      if (!/\b(?:convert|move|top up|sweep|exchange|swap)\b/i.test(s) || !/\b(?:reserve|euro)\b/i.test(s)) throw new RailError("invalid_instruction", "The demo owner authorized tUSD → euro-reserve conversions only. Other financial objectives require a separate signed mandate.", 422);
      const parsed = rail.v.amounts.scanAmount(s);
      if (parsed.kind !== "valid") throw new RailError("invalid_instruction", "Specify one unambiguous amount in positive tUSD in standard decimal notation (for example, 10 tUSD).", 422);
      if (!/\b(?:tusd|test\s*(?:usd|dollars?))\b/i.test(s)) throw new RailError("invalid_instruction", "Specify one unambiguous amount with the denomination tUSD explicitly.", 422);
      if (parsed.raw <= 0n) throw new RailError("invalid_instruction", "An execution amount must be greater than zero.", 422);
      if (parsed.raw > 25_000_000n) throw new RailError("over_mandate", `Owner mandate refuses this payment: ${rail.v.amounts.formatMicro(parsed.raw)} tUSD exceeds the signed per-payment limit of 25 tUSD. The AI cannot raise it. Ask the owner to sign a new mandate.`, 422);
      instruction = s;
    } // like the release, an instruction sent with another scenario is ignored: those scripts take no input
    const impact = input.impact === undefined ? 150 : input.impact;
    if (![50, 150].includes(impact)) throw new RailError("invalid_request", "Supported impact policies: 50 or 150 basis points.", 422);
    return { scenario, instruction, impact };
  };

  const start = (body: unknown, idempotencyKey: unknown): Accepted => {
    const request = validate(body);
    const prior = typeof idempotencyKey === "string" ? rail.store.submission(idempotencyKey) : undefined;
    if (host.economy && !prior) throw new RailError("economy_running", "A scripted economy is already running on this machine. Wait for it to complete.", 409, host.economy.workspaceId === rail.id ? { jobId: host.economy.jobId } : {});
    const accepted = rail.submit("economy", request, idempotencyKey);
    if (!accepted.duplicate && !host.economy) host.economy = { jobId: accepted.jobId, workspaceId: rail.id, child: null };
    return accepted;
  };

  rail.handlers.set("economy", async (ctx): Promise<OpResult> => {
    if (host.economy && host.economy.jobId !== ctx.jobId) throw new RailError("economy_running", "A scripted economy is already running on this machine. Wait for it to complete.", 409);
    host.economy = { jobId: ctx.jobId, workspaceId: rail.id, child: null };
    const active = host.economy;
    const runDir = join(CHAIN_DIR, ".runs", ctx.jobId), outDir = join(outRoot(), ctx.jobId);
    let socketDir: string | null = null;
    const front: { server: import("node:http").Server | null } = { server: null };
    try {
      const req = validate(ctx.request);
      const E = ECONOMIES[req.scenario];
      const busy: number[] = [];
      for (const port of [rail.cfg.economyAnvilPort, ...(req.scenario === "economy" ? [7701, 7702, 7703] : [])]) if (!(await portFree(port))) busy.push(port);
      if (busy.length) throw new RailError("ports_in_use", `This run needs loopback port(s) ${busy.join(", ")}, which another process holds. Nothing was started.`, 409);
      // F-14 and lead L-13: the release's script starts its own Anvil, without --no-cors, on ANVIL_PORT, and its services get
      // an allowlisted environment with only that address. So a stand-in `anvil` first on its PATH puts Anvil on a port
      // browsers refuse, with --no-cors and a private socket, and the run's port is a guarded front (chain-socket.ts
      // startChainGuard) that answers local programs and refuses what a web page can send.
      let chainPort = 0;
      for (const p of BROWSER_BLOCKED_PORTS) if (await portFree(p)) { chainPort = p; break; }
      if (!chainPort) throw new RailError("ports_in_use", "No port that browsers refuse is free for this run's chain. Nothing was started.", 409);
      rmSync(runDir, { recursive: true, force: true });
      mkdirSync(join(runDir, "evidence"), { recursive: true });
      mkdirSync(outDir, { recursive: true });
      const root = rail.cfg.vendorRoot;
      for (const d of ["agent", "contracts", "relay", ...(E.needsZk ? ["circuits"] : [])]) symlinkSync(join(root, d), join(runDir, d));
      symlinkSync(join(root, "evidence", "ethereum-sepolia"), join(runDir, "evidence", "ethereum-sepolia"));
      socketDir = socketFolder();
      const socket = join(socketDir, "anvil.ipc");
      mkdirSync(join(runDir, ".bin"));
      writeFileSync(join(runDir, ".bin", "anvil"), `#!/bin/sh\n# The rail's stand-in (F-14): the release's own Anvil command on a port browsers refuse, with no CORS header and a private socket.\n[ "$1" = "--port" ] || { echo "anvil stand-in: expected --port first" >&2; exit 64; }\nshift 2\nexec ${shq(rail.cfg.anvilBin)} --port ${chainPort} "$@" --no-cors --ipc ${shq(socket)}\n`, { mode: 0o700 });
      const env: Record<string, string> = {
        PATH: `${join(runDir, ".bin")}:${join(homedir(), ".foundry", "bin")}:${process.env.PATH ?? ""}`, HOME: process.env.HOME ?? "",
        SCRIPT: E.script, EVIDENCE_DIR: outDir, ANVIL_PORT: String(rail.cfg.economyAnvilPort),
        QED_DEMO_INSTRUCTION: req.instruction, POLICY_IMPACT_BPS: String(req.impact), QED_OFFLINE: "1",
        ...(req.scenario === "economy" ? {} : { KEYS_FILE: "/nonexistent" }),
      };
      ctx.push({ key: "start", label: `Scripted economy: ${E.title}`, status: "info", detail: `The release's ${E.script} starts on a fresh Anvil chain of its own (its listener on port ${chainPort}, which browsers refuse; its programs reach it through a guarded front on port ${rail.cfg.economyAnvilPort} that refuses web pages), with development keys and the labelled offline parser. Fixed scenario${req.instruction ? `; instruction: “${req.instruction}”` : ""}. The main treasury is not involved.`, data: { scenario: req.scenario, network: "Anvil 31337 (a separate local chain for this run; disposable, valueless)" } });
      const cmd = withoutCaps(process.execPath, ["--import", "tsx", "agent/scripts/local.ts"]); // R13 review fix F3 (caps.ts)
      const child = spawn(cmd.file, cmd.args, { cwd: runDir, env, stdio: ["ignore", "pipe", "pipe"] });
      active.child = child;
      if (child.pid) writeFileSync(runnerPidFile(), String(child.pid));
      // the front opens once Anvil's socket exists: after the release script has checked that the run's port is free
      void (async () => {
        for (let i = 0; i < 1200 && !front.server && child.exitCode === null; i++) {
          if (existsSync(socket)) { front.server = await startChainGuard(rail.cfg.economyAnvilPort, socket).catch(() => null); break; }
          await new Promise((r) => setTimeout(r, 50));
        }
      })();
      const logs: string[] = [];
      const onLog = (buf: Buffer) => {
        for (const line of buf.toString().split(/\r?\n/)) {
          const text = line.replace(/\x1b\[[0-9;]*m/g, "").trim().slice(0, 300);
          // Only the script's own progress lines are kept; anything else could be an environment or stack dump.
          if (text && /^(PHASE |DONE\.|FATAL|✓|✗|•|QED |no \.keys\.env|ERROR|exported )/.test(text)) { logs.push(text); if (logs.length > 60) logs.shift(); }
        }
      };
      child.stdout!.on("data", onLog);
      child.stderr!.on("data", onLog);
      let emitted = 0;
      const manifest = () => { try { return JSON.parse(readFileSync(join(outDir, "manifest.json"), "utf8")); } catch { return null; } };
      const refresh = () => {
        const steps = manifest()?.steps ?? [];
        for (; emitted < steps.length; emitted++) {
          const s = steps[emitted];
          const status: StepStatus = s.offchain ? "info" : s.tx?.status === "reverted" ? "reverted" : "ok";
          ctx.push({ key: String(s.id), label: String(s.title).slice(0, 240), status, detail: s.offchain ? `Off-chain step by ${s.actor}. ${String(s.narrative ?? "").slice(0, 400)}` : `${s.tx.status === "reverted" ? `Mined as a revert${s.error ? `: ${s.error.name}` : ""}` : "Mined"} in block ${s.tx.blockNumber} by ${s.actor}. ${String(s.narrative ?? "").slice(0, 300)}`, data: { phase: s.phase, actor: s.actor, expect: s.expect, transaction: s.tx ? { hash: s.tx.hash, status: s.tx.status, block: s.tx.blockNumber, gas: s.tx.gasUsed } : null, error: s.error ? { name: s.error.name } : null, attack: s.attack ?? null } });
        }
      };
      const poll = setInterval(refresh, 400);
      const killer = setTimeout(() => child.kill("SIGTERM"), 12 * 60_000);
      const code = await new Promise<number | null>((done) => { child.on("error", () => done(-1)); child.on("exit", (c) => done(c)); });
      clearInterval(poll);
      clearTimeout(killer);
      refresh();
      rmSync(join(outDir, "honeypot.json"), { force: true });
      const ev = manifest();
      const steps: any[] = ev?.steps ?? [];
      if (code !== 0 || !steps.length) throw new RailError("economy_failed", `The scripted economy did not complete (exit ${code}${steps.length ? `, ${steps.length} steps recorded` : ", no step recorded"}). ${logs.filter((l) => /^(FATAL|ERROR)/.test(l)).slice(-1)[0] ?? ""}`.trim(), 500, { lastLines: logs.slice(-8) });
      const bundledIds: string[] = JSON.parse(readFileSync(join(root, E.bundled), "utf8")).steps.map((s: any) => String(s.id));
      const ids = steps.map((s) => String(s.id));
      const reverted = steps.filter((s) => s.tx?.status === "reverted").length;
      const summary = `${E.title}: completed with ${steps.length} steps on its own chain (${steps.filter((s) => s.tx).length} transactions, ${reverted} mined as reverts as intended, ${steps.filter((s) => s.offchain).length} off-chain). Scripted, fixed scenario.`;
      rail.record(ctx, { kind: "economy", title: summary, outcome: "executed" });
      return { outcome: "executed", summary, evidence: { label: "SCRIPTED", scenario: req.scenario, network: "Anvil 31337 (a separate local chain for this run; disposable, valueless)", aiEngine: "offline-deterministic", steps: steps.length, transactions: steps.filter((s) => s.tx).length, reverted, final: ev.final ?? null, policyRun: ev.policyRun ?? null, policyChain: ev.policyChain ?? null, comparedWithBundledManifest: { manifest: E.bundled, bundledSteps: bundledIds.length, missingHere: bundledIds.filter((i) => !ids.includes(i)), onlyHere: ids.filter((i) => !bundledIds.includes(i)) }, outputFolder: outDir, lastLines: logs.slice(-12) } };
    } finally {
      rmSync(runDir, { recursive: true, force: true });
      front.server?.close();
      if (socketDir) rmSync(socketDir, { recursive: true, force: true });
      rmSync(runnerPidFile(), { force: true });
      if (host.economy?.jobId === ctx.jobId) host.economy = null;
    }
  });

  /** A runner left behind by a killed rail is stopped at the next start; its own Anvil dies with it. */
  const reapOrphan = () => {
    try {
      const pid = Number(readFileSync(runnerPidFile(), "utf8").trim());
      if (Number.isInteger(pid) && pid > 1 && /agent\/scripts\/local\.ts/.test(execFileSync("ps", ["-p", String(pid), "-o", "command="]).toString())) process.kill(pid, "SIGTERM");
    } catch { /* no runner */ }
    rmSync(runnerPidFile(), { force: true });
  };
  const stop = () => { if (host.economy?.workspaceId === rail.id) host.economy.child?.kill("SIGTERM"); };
  const list = () => (Object.keys(ECONOMIES) as EconomyName[]).map((name) => ({ scenario: name, title: ECONOMIES[name].title, label: "SCRIPTED", available: !ECONOMIES[name].needsZk || zkAvailable(), takesInstruction: name === "execution", bundledManifest: ECONOMIES[name].bundled, running: host.economy !== null }));
  /** This workspace's running economy, if any (another workspace's run is not named). */
  return { start, list, stop, reapOrphan, validate, active: () => (host.economy?.workspaceId === rail.id ? host.economy.jobId : null) };
}
