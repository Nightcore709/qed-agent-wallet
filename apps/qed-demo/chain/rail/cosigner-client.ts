/**
 * The rail's side of the separate co-signer process: it holds an IPC channel and addresses, and hands the co-signer its
 * own key file. One process serves every workspace scope of the host. See cosigner-main.ts for what the separation does
 * and does not give.
 *
 * Least privilege (docs/LEAST-PRIVILEGE.md, R13): the co-signer opens no keyring. When sealing is on, cosigner.key exists
 * only sealed under the wallet-secret keyring, which this process (the wallet service) holds anyway for master.key. So
 * this process opens the co-signer's file (readSecret: sealed, or plaintext of mode 600 when sealing is off) and writes
 * its bytes into a pipe the child inherits as file descriptor 4, at every start and restart; the plaintext is never
 * written to disk. A key the co-signer creates later (a new workspace scope or a rotation) comes back over the IPC
 * channel and is written here (writeSecret: sealed when sealing is on) before the co-signer answers the request that
 * needed it. The child's environment is exactly cosignerEnv(): no QED_KEY_DIR, QED_KEY_FILE, QED_KEK or QED_RAIL_SEAL,
 * and not the key file's path; its HOME is an empty folder of its own (R13 review fix F3). With QED_COSIGNER_UID and
 * QED_COSIGNER_GID set (the container sets them), it runs as that separate user (cosignerCommand), and the operating
 * system keeps it out of the key folder; without them, both processes run as one user and the key folder stays readable
 * to the co-signer's process by the operating system (docs/LEAST-PRIVILEGE.md; a KMS or an HSM remains; baseline L-01).
 */
import { spawn, type ChildProcess } from "node:child_process";
import { chmodSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Writable } from "node:stream";
import { fileURLToPath } from "node:url";
import type { Address } from "viem";
import { CHAIN_DIR } from "./config.ts";
import type { CosignerConfig, CosignerHost } from "./cosigner.ts";
import { checkKeyFile, cosignerCommand, cosignerEnv, KEYS_FD } from "./cosigner-env.ts";
import { readSecret, writeSecret } from "./sealed-at-rest.ts";

const big = (x: unknown) => JSON.stringify(x, (_, v) => (typeof v === "bigint" ? { $big: v.toString() } : v));
const unbig = (s: string) => JSON.parse(s, (_, v) => (v && typeof v === "object" && "$big" in v ? BigInt(v.$big) : v));

export class ProcessCosigner implements CosignerHost {
  readonly isolation = "separate-process" as const;
  private child: ChildProcess | null = null;
  private seq = 0;
  private pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>();
  /** Each scope's configuration, given back to a restarted process before anything else. */
  private configs = new Map<string, CosignerConfig>();
  private cached = new Map<string, Address>();
  private stopped = false;
  /** Whether the key file exists (sealed or not): the first write of a new one must not replace anything. */
  private keysExist = false;
  private readonly opts: { keyFile: string; stateFile: string; vendorRoot: string };
  /** The co-signer's own HOME: an empty folder, not this user's (R13 review fix F3); removed when it stops. */
  private readonly home: string;
  private constructor(opts: { keyFile: string; stateFile: string; vendorRoot: string }) {
    this.opts = opts;
    this.home = mkdtempSync(join(tmpdir(), "qed-cosigner-home-"));
    chmodSync(this.home, 0o755); // empty; readable so that a co-signer running as another user may use it
  }
  static async start(opts: { keyFile: string; stateFile: string; vendorRoot: string }): Promise<ProcessCosigner> {
    const c = new ProcessCosigner(opts);
    await c.spawn();
    return c;
  }
  get pid(): number | null { return this.child?.pid ?? null; }

  private spawn(): Promise<void> {
    // The co-signer's own keys, opened here (sealed under the wallet-secret keyring when sealing is on); it opens none.
    let keys: Buffer | null;
    try { keys = readSecret(this.opts.keyFile, { validate: checkKeyFile }); } catch (e) { return Promise.reject(e); }
    this.keysExist = keys !== null;
    return new Promise((ready, fail) => {
      let cmd: { file: string; args: string[] };
      try { cmd = cosignerCommand(["--import", "tsx", fileURLToPath(new URL("./cosigner-main.ts", import.meta.url))]); } catch (e) { fail(e as Error); return; }
      const child = spawn(cmd.file, cmd.args, {
        cwd: CHAIN_DIR,
        // Exactly what it needs: no other variable of the rail's environment reaches the co-signer, and no key setting.
        env: cosignerEnv({ ...this.opts, home: this.home }),
        stdio: ["ignore", "ignore", "inherit", "ipc", "pipe"],
      });
      this.child = child;
      // the key file's bytes on the child's fd 4, then end of file: never on disk in plaintext
      const pipe = child.stdio[KEYS_FD] as Writable | null;
      pipe?.on("error", () => { /* the child exited first: its exit is handled below */ });
      // zeroed once written (the write is asynchronous: zeroing it any earlier would corrupt what is sent)
      pipe?.end(keys ?? Buffer.alloc(0), () => keys?.fill(0));
      const timer = setTimeout(() => fail(new Error("the co-signer process did not start")), 20_000);
      child.on("message", (m: { id: number; ok: boolean; payload?: string; error?: string; persist?: string; ref?: number }) => {
        if (typeof m.persist === "string") { this.persist(child, m.persist, m.ref ?? 0); return; }
        if (m.id === 0) { clearTimeout(timer); ready(); return; }
        const p = this.pending.get(m.id);
        if (!p) return;
        this.pending.delete(m.id);
        if (m.ok) p.resolve(unbig(m.payload!)); else p.reject(new Error(m.error ?? "co-signer error"));
      });
      child.on("exit", () => {
        if (this.child === child) this.child = null;
        for (const p of this.pending.values()) p.reject(new Error("The co-signer process stopped before it answered. Nothing was signed."));
        this.pending.clear();
      });
      child.on("error", (e) => { clearTimeout(timer); fail(e); });
    });
  }
  /**
   * A key file the co-signer made (a new scope or version), written here before the co-signer answers the request that
   * needed it: sealed when sealing is on, else plaintext of mode 600. The first write of a new file never replaces one.
   */
  private persist(child: ChildProcess, json: string, ref: number): void {
    let error: string | null = null;
    try {
      const bytes = Buffer.from(json, "utf8");
      checkKeyFile(bytes);
      writeSecret(this.opts.keyFile, bytes, { fresh: !this.keysExist });
      this.keysExist = true;
      bytes.fill(0);
    } catch (e) {
      error = String((e as Error)?.message ?? e).split("\n")[0]!.slice(0, 300);
    }
    if (child.connected) child.send(error ? { persisted: ref, ok: false, error } : { persisted: ref, ok: true });
  }

  /** Asks the co-signer. If its process died, it is started again first and given every scope's configuration back. */
  private async ask(op: string, scope: string | null, payload: unknown = {}): Promise<any> {
    if (this.stopped) throw new Error("co-signer stopped");
    if (!this.child || !this.child.connected) {
      await this.spawn();
      for (const [s, cfg] of this.configs) await this.send("configure", s, cfg);
    }
    return this.send(op, scope, payload);
  }
  private send(op: string, scope: string | null, payload: unknown): Promise<any> {
    return new Promise((resolve, reject) => {
      const id = ++this.seq;
      this.pending.set(id, { resolve, reject });
      this.child!.send({ id, op, ...(scope ? { scope } : {}), payload: big(payload) }, (e) => { if (e) { this.pending.delete(id); reject(new Error("The co-signer process is not reachable. Nothing was signed.")); } });
    });
  }

  async address(scope: string) {
    const known = this.cached.get(scope);
    if (known) return known;
    const a = (await this.ask("address", scope)).address as Address;
    this.cached.set(scope, a);
    return a;
  }
  async alive() { return !!this.child && this.child.connected && this.child.exitCode === null; }
  async configure(scope: string, cfg: CosignerConfig) { this.configs.set(scope, cfg); this.cached.set(scope, (await this.ask("configure", scope, cfg)).address); }
  async call(scope: string, op: string, payload: any) {
    const out = await this.ask(op, scope, payload);
    if (op === "commitRotation") this.cached.set(scope, out.address);
    return out;
  }
  async stop() {
    this.stopped = true;
    const child = this.child;
    if (child) await new Promise<void>((done) => { child.once("exit", () => done()); child.kill("SIGTERM"); setTimeout(() => { child.kill("SIGKILL"); }, 2_000).unref(); });
    rmSync(this.home, { recursive: true, force: true });
  }
}
