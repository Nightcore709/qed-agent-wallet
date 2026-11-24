/**
 * Supervises one Anvil child process and persists its state.
 *
 * Reachability (security review R13, F-14): Anvil always opens a TCP listener and checks neither Origin nor Host, so the
 * rail puts that listener on a port browsers refuse (chain-socket.ts BROWSER_BLOCKED_PORTS) and talks to Anvil only over
 * its IPC socket, in a folder only this operating-system user may enter. `url` (http://127.0.0.1:<that port>) stays the
 * chain's address for the vendored clients; chain-socket.ts answers it over the socket. The port and the socket are kept
 * across a restart of the same chain, so every client keeps working; both are recorded in `anvil.endpoint.json` beside
 * the pid file.
 *
 * Persistence (confirmed on Anvil 1.7.1, see README.md): `anvil_dumpState` returns the whole chain, including
 * blocks, transactions and receipts; a fresh Anvil that receives it through `anvil_loadState` continues at the same
 * block number and hash and mines the next block at wall time. The rail writes a dump after every job, atomically
 * (temporary file, fsync, rename), so the state file always holds a complete chain.
 *
 * An Anvil that outlives a killed rail is recognised by the pid file this class writes and its command line (its socket,
 * or for a chain started before R13, its old port) and is stopped at the next start; a port held by any other process is
 * left alone.
 */
import { spawn, execFileSync, type ChildProcess } from "node:child_process";
import { chmodSync, closeSync, existsSync, fsyncSync, mkdirSync, mkdtempSync, openSync, readFileSync, renameSync, rmSync, writeFileSync, writeSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { CHAIN_ID } from "./config.ts";
import { BROWSER_BLOCKED_PORTS, ChainSocket, isBrowserBlocked, routeChain, unrouteChain } from "./chain-socket.ts";
import { withoutCaps } from "./caps.ts";

export function atomicWrite(path: string, data: string, write: (fd: number, data: string) => unknown = writeSync): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp`;
  try {
    const fd = openSync(tmp, "w", 0o600);
    try { write(fd, data); fsyncSync(fd); } finally { closeSync(fd); }
    renameSync(tmp, path);
  } catch (e) {
    try { rmSync(tmp, { force: true }); } catch { /* not ours to remove */ }
    throw e;
  }
}

/** Whether 127.0.0.1:`port` can be bound now (false when another process holds it or the system refuses it). */
export const portFree = (port: number): Promise<boolean> => new Promise((ok) => {
  const probe = createServer();
  probe.once("error", () => ok(false));
  probe.listen(port, "127.0.0.1", () => probe.close(() => ok(true)));
});

/** A private folder for a chain's IPC socket: short enough for a socket path, and only this user may enter it (0700). */
export const socketFolder = (): string => mkdtempSync(join(tmpdir(), "qed-chain-"));
const SOCKET_FOLDER_RE = /\/qed-chain-[A-Za-z0-9]{6}$/;

export class Anvil {
  status: "stopped" | "starting" | "up" | "failed" = "stopped";
  error: string | null = null;
  version: string | null = null;
  private child: ChildProcess | null = null;
  private stopping = false;
  private exitListeners: ((code: number | null) => void)[] = [];
  readonly bin: string;
  readonly stateFile: string;
  readonly pidFile: string;
  /** Beside the pid file: where this chain listens and its socket, for the next start and for tests (owner-only). */
  readonly endpointFile: string;
  /** The port a chain started before R13 listened on (8546 by default): only to recognise one such chain left running. */
  readonly legacyPort: number | null;
  #port: number | null;
  #socketDir: string | null = null;
  #socket: ChainSocket | null = null;

  constructor(opts: { bin: string; stateFile: string; pidFile: string; port?: number; legacyPort?: number }) {
    if (opts.port !== undefined && !isBrowserBlocked(opts.port)) throw new Error(`Port ${opts.port} can be reached by a web page; the local chain listens only on a port browsers refuse (chain/rail/chain-socket.ts).`);
    this.bin = opts.bin;
    this.#port = opts.port ?? null;
    this.stateFile = opts.stateFile;
    this.pidFile = opts.pidFile;
    this.endpointFile = join(dirname(opts.pidFile), `${basename(opts.pidFile, ".pid")}.endpoint.json`);
    this.legacyPort = opts.legacyPort ?? null;
  }

  /** The TCP port Anvil was made to bind (one browsers refuse). Known once the chain has started. */
  get port(): number {
    if (this.#port === null) throw new Error("The local chain has not started yet.");
    return this.#port;
  }
  /** The chain's address for the vendored clients in this process; answered over the socket, never over TCP. */
  get url(): string {
    return `http://127.0.0.1:${this.port}`;
  }
  /** Anvil's IPC socket, the only way the rail talks to it. */
  get socketPath(): string {
    if (!this.#socketDir) throw new Error("The local chain has not started yet.");
    return join(this.#socketDir, "anvil.ipc");
  }
  get pid(): number | null {
    return this.child?.pid ?? null;
  }
  onExit(f: (code: number | null) => void) {
    this.exitListeners.push(f);
  }

  /** Raw JSON-RPC over the socket, with a short timeout and no retry: an unresponsive chain is reported, never waited for. */
  async rpc(method: string, params: unknown[] = [], timeoutMs = 20_000): Promise<unknown> {
    if (!this.#socket) throw new Error(`${method}: the local chain is not running`);
    return this.#socket.rpc(method, params, timeoutMs);
  }

  /** Stops an Anvil left behind by an earlier rail process, identified by our own pid file and its command line. */
  private reapOrphan(): boolean {
    let reaped = false;
    let before: { socket?: string } = {};
    try { before = JSON.parse(readFileSync(this.endpointFile, "utf8")) as { socket?: string }; } catch { /* none, or from before R13 */ }
    if (existsSync(this.pidFile)) {
      try {
        const pid = Number(readFileSync(this.pidFile, "utf8").trim());
        if (Number.isInteger(pid) && pid > 1) {
          const cmd = execFileSync("ps", ["-p", String(pid), "-o", "command="]).toString();
          const ours = (before.socket && cmd.includes(`--ipc ${before.socket}`)) || (this.legacyPort !== null && cmd.includes(`--port ${this.legacyPort}`));
          if (/anvil/.test(cmd) && ours) {
            process.kill(pid, "SIGKILL");
            reaped = true;
          }
        }
      } catch { /* not running any more */ }
      rmSync(this.pidFile, { force: true });
    }
    // the private folder of the socket that chain used (never this chain's own, kept across a restart)
    const old = before.socket ? dirname(before.socket) : null;
    if (old && old !== this.#socketDir && SOCKET_FOLDER_RE.test(old)) rmSync(old, { recursive: true, force: true });
    return reaped;
  }

  async start(): Promise<{ reapedOrphan: boolean }> {
    this.status = "starting";
    this.error = null;
    this.stopping = false;
    const reapedOrphan = this.reapOrphan();
    try { this.version = execFileSync(this.bin, ["--version"]).toString().split("\n")[0].trim(); } catch { this.version = null; }
    mkdirSync(dirname(this.pidFile), { recursive: true });
    this.#socketDir ??= socketFolder();
    rmSync(this.socketPath, { force: true }); // a socket left by a chain that died
    // A chain that ran before keeps its port, so every client's address stays valid; a new one takes the first free
    // port browsers refuse, waiting a little if all are taken (other chains starting at the same moment).
    const fixed = this.#port;
    for (let round = 0; round < 30; round++) {
      for (const port of fixed !== null ? [fixed] : BROWSER_BLOCKED_PORTS) {
        if (!(await portFree(port))) continue;
        const r = await this.spawnOn(port);
        if (r === "up") return { reapedOrphan };
        if (r === "failed") throw new Error(this.error ?? "Anvil startup failed");
      }
      await new Promise((r) => setTimeout(r, 100));
    }
    this.status = "failed";
    this.error = fixed !== null ? `Port ${fixed}, where this chain listened before, is in use by another process; it was left untouched.` : "No port that browsers refuse is free for the local chain's listener.";
    throw new Error(this.error);
  }

  /** One attempt on one port: "up", "taken" (another process bound it first) or "failed". */
  private async spawnOn(port: number): Promise<"up" | "taken" | "failed"> {
    // --no-cors as well: Anvil then sends no CORS header, should a page ever reach the listener.
    // R13 review fix F3: in the container, without the capabilities the wallet service keeps for the co-signer (caps.ts)
    const cmd = withoutCaps(this.bin, ["--host", "127.0.0.1", "--port", String(port), "--ipc", this.socketPath, "--chain-id", String(CHAIN_ID), "--hardfork", "osaka", "--base-fee", "21", "--gas-limit", "60000000", "--no-cors", "--silent"]);
    const child = spawn(cmd.file, cmd.args,
      { stdio: ["ignore", "ignore", "pipe"], env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "" } });
    let stderr = "";
    child.stderr!.on("data", (d: Buffer) => { stderr = (stderr + d.toString()).slice(-600); });
    let exited: number | null | undefined;
    let spawnError: string | null = null;
    child.on("error", (e) => { spawnError = e.message; });
    child.once("exit", (code) => { exited = code; });
    const probe = new ChainSocket(this.socketPath);
    try {
      for (let i = 0; i < 150; i++) {
        if (spawnError) { this.status = "failed"; this.error = `Unable to start Anvil: ${spawnError}`; return "failed"; }
        if (exited !== undefined) {
          if (/address already in use|os error (48|98)|permission denied|os error 13/i.test(stderr)) return "taken";
          this.status = "failed";
          this.error = `The local chain process exited (${exited})${stderr ? `: ${stderr.trim().split("\n")[0]!.slice(0, 200)}` : ""}.`;
          return "failed";
        }
        try {
          if (Number(await probe.rpc("eth_chainId", [], 1_000)) === CHAIN_ID) break;
        } catch { /* not yet */ }
        if (i === 149) { child.kill("SIGKILL"); this.status = "failed"; this.error = "Anvil startup timed out."; return "failed"; }
        await new Promise((r) => setTimeout(r, 100));
      }
    } finally { probe.close(); }
    chmodSync(this.socketPath, 0o600);
    this.#port = port;
    this.child = child;
    child.on("exit", (code) => {
      if (this.child === child) this.child = null;
      rmSync(this.pidFile, { force: true });
      if (!this.stopping) {
        this.status = "failed";
        this.error = `The local chain process exited (${code}).`;
        for (const f of this.exitListeners) f(code);
      } else this.status = "stopped";
    });
    if (child.pid) writeFileSync(this.pidFile, String(child.pid));
    atomicWrite(this.endpointFile, JSON.stringify({ url: this.url, socket: this.socketPath, tcp: `127.0.0.1:${port} (a port browsers refuse; not used by the rail)` }));
    this.#socket = routeChain(this.url, this.socketPath);
    this.status = "up";
    return "up";
  }

  async stop(): Promise<void> {
    this.stopping = true;
    const child = this.child;
    if (child) {
      await new Promise<void>((done) => {
        const t = setTimeout(() => { child.kill("SIGKILL"); }, 2_000);
        child.once("exit", () => { clearTimeout(t); done(); });
        child.kill("SIGTERM");
      });
    }
    if (this.#socket) unrouteChain(this.url, this.socketPath);
    this.#socket = null;
    if (this.#socketDir) rmSync(this.#socketDir, { recursive: true, force: true });
    this.#socketDir = null;
    rmSync(this.endpointFile, { force: true });
    this.status = "stopped";
  }
  /** Read-only liveness for health checks. */
  async alive(): Promise<boolean> {
    if (this.status !== "up") return false;
    try { return Number(await this.rpc("eth_chainId", [], 1_500)) === CHAIN_ID; } catch { return false; }
  }

  hasState(): boolean {
    return existsSync(this.stateFile);
  }
  /** Writes the complete chain state atomically. Returns the size written. */
  async dumpState(): Promise<number> {
    const hex = (await this.rpc("anvil_dumpState", [], 60_000)) as string;
    if (typeof hex !== "string" || !hex.startsWith("0x")) throw new Error("anvil_dumpState returned no state");
    atomicWrite(this.stateFile, hex);
    return hex.length;
  }
  async loadState(): Promise<void> {
    const hex = readFileSync(this.stateFile, "utf8");
    if (!hex.startsWith("0x")) throw new Error("The saved chain state is not a state dump.");
    if ((await this.rpc("anvil_loadState", [hex], 60_000)) !== true) throw new Error("Anvil did not accept the saved chain state.");
  }
}
