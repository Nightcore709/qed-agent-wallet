/**
 * Starts the loopback service as a real process (node serve.ts) with its own data folder and ports.
 *
 * By default it runs in baseline-parity mode (the release's development owner, one workspace "baseline"), as the
 * tests written before R7 expect, and `call`, `raw`, `act` and `job` address that workspace: a path other than
 * /health or /workspaces/… is sent as /workspaces/baseline/<path>. `workspace: null` turns the prefix off.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { readFileSync } from "node:fs";
import { request as httpRequest } from "node:http";
import { homedir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { CHAIN, freshDir, key } from "./helpers.ts";
import type { Accepted, Job, Proposal } from "../types.ts";
import { routeChain } from "../rail/chain-socket.ts";

/**
 * A running service's chain, for this test process: its address (a port browsers refuse), answered over the IPC socket
 * the service recorded beside its pid file (rail/anvil.ts, F-14). The test runs as the same user, so it may enter.
 */
export function serviceChain(dir: string): string {
  const e = JSON.parse(readFileSync(join(dir, "rail", "anvil.endpoint.json"), "utf8")) as { url: string; socket: string };
  routeChain(e.url, e.socket);
  return e.url;
}

export interface Service {
  child: ChildProcess;
  dir: string;
  port: number;
  token: string;
  log: () => string;
  /** JSON call with the bearer token. */
  call: <T = any>(method: "GET" | "POST", path: string, body?: unknown, headers?: Record<string, string>) => Promise<{ status: number; data: T; headers: Headers }>;
  raw: (opts: { method?: string; path: string; headers?: Record<string, string>; body?: string }) => Promise<{ status: number; headers: Record<string, unknown>; text: string }>;
  until: (f: () => Promise<boolean>, ms: number, label: string) => Promise<void>;
  /** propose → approve → execute → wait for the job. */
  act: (kind: string, params?: Record<string, unknown>) => Promise<Job>;
  job: (id: string) => Promise<Job>;
  stop: (signal?: NodeJS.Signals) => Promise<number | null>;
  /** After a deliberate hard kill of the service: stop the Anvil it left behind. */
  reapAnvil: () => void;
}

export async function startService(name: string, port: number, anvilPort: number, opts: { dir?: string; env?: Record<string, string>; waitReady?: boolean; workspace?: string | null; listenMs?: number } = {}): Promise<Service> {
  const dir = opts.dir ?? freshDir(name);
  const ws = opts.workspace === undefined ? "baseline" : opts.workspace;
  const at = (path: string) => (ws === null || path === "/health" || path.startsWith("/workspaces") ? path : `/workspaces/${ws}${path}`);
  const child = spawn(process.execPath, [join(CHAIN, "serve.ts")], {
    cwd: CHAIN,
    env: { PATH: `${join(homedir(), ".foundry", "bin")}:${process.env.PATH}`, HOME: homedir(), QED_RAIL_DATA: dir, QED_RAIL_PORT: String(port), QED_RAIL_ANVIL_PORT: String(anvilPort), QED_RAIL_ECONOMY_ANVIL_PORT: String(anvilPort + 500), QED_RAIL_MODE: "baseline-parity", ...(opts.env ?? {}) },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let log = "";
  child.stdout!.on("data", (d) => (log += d));
  child.stderr!.on("data", (d) => (log += d));
  const base = `http://127.0.0.1:${port}`;
  const until = async (f: () => Promise<boolean>, ms: number, label: string) => {
    const end = Date.now() + ms;
    for (;;) {
      if (await f().catch(() => false)) return;
      if (child.exitCode !== null) throw new Error(`service exited (${child.exitCode}) while waiting for ${label}: ${log.slice(-600)}`);
      if (Date.now() > end) throw new Error(`timed out waiting for ${label}: ${log.slice(-600)}`);
      await sleep(100);
    }
  };
  try { await until(async () => (await fetch(`${base}/health`)).status > 0, opts.listenMs ?? 20_000, "the HTTP listener"); }
  catch (e) { child.kill("SIGKILL"); throw e; }
  const token = readFileSync(join(dir, "rail.token"), "utf8").trim();
  const call: Service["call"] = async (method, path, body, headers = {}) => {
    const r = await fetch(base + at(path), { method, headers: { Authorization: `Bearer ${token}`, ...(body !== undefined ? { "Content-Type": "application/json" } : {}), ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
    const text = await r.text();
    return { status: r.status, data: text ? JSON.parse(text) : null, headers: r.headers };
  };
  const raw: Service["raw"] = (o) => new Promise((resolve, reject) => {
    const req = httpRequest({ host: "127.0.0.1", port, method: o.method ?? "GET", path: at(o.path), headers: o.headers ?? {} }, (res) => {
      let text = "";
      res.on("data", (d) => (text += d));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers, text }));
    });
    req.on("error", reject);
    req.end(o.body);
  });
  const job = async (id: string) => {
    for (let i = 0; i < 600; i++) {
      const j = (await call<Job>("GET", `/jobs/${id}`)).data;
      if (["done", "failed", "interrupted"].includes(j.status)) return j;
      await sleep(100);
    }
    throw new Error("job did not finish");
  };
  const act: Service["act"] = async (kind, params = {}) => {
    const p = (await call<Proposal>("POST", "/proposals", { kind, params })).data;
    if (!p.id) throw new Error(`proposal refused: ${JSON.stringify(p)}`);
    const approval = { approvalId: `ap-${key()}`, docHash: `sha256:${"d".repeat(64)}`, termsHash: p.termsHash, confirmedAt: new Date().toISOString(), method: "test-owner" };
    const a = await call<Accepted>("POST", `/proposals/${p.id}/execute`, { approval }, { "Idempotency-Key": key() });
    if (a.status !== 202) throw new Error(`not accepted: ${JSON.stringify(a.data)}`);
    return job(a.data.jobId);
  };
  /** Stops the Anvil this service started, found through the pid file the rail keeps (needed after a hard kill). */
  const reapAnvil = () => {
    try {
      const pid = Number(readFileSync(join(dir, "rail", "anvil.pid"), "utf8").trim());
      if (Number.isInteger(pid) && pid > 1) process.kill(pid, "SIGKILL");
    } catch { /* no Anvil left */ }
  };
  const stop: Service["stop"] = (signal = "SIGTERM") => new Promise((resolve) => {
    const done = (code: number | null) => { if (signal === "SIGKILL" || code !== 0) reapAnvil(); resolve(code); };
    if (child.exitCode !== null || child.signalCode) return done(child.exitCode);
    child.once("exit", (code) => done(code));
    child.kill(signal);
  });
  if (opts.waitReady !== false) {
    try { await until(async () => (await fetch(`${base}/health`)).status === 200, 60_000, "readiness"); }
    catch (e) { await stop("SIGKILL"); throw e; }
  }
  return { child, dir, port, token, log: () => log, call, raw, until, act, job, stop, reapAnvil };
}

