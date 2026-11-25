/**
 * The local chain's only door (security review R13, F-14; standards gap G-C4).
 *
 * Anvil 1.7.1 always opens a TCP listener (an empty `--host` is refused: "invalid IP address syntax") and checks neither
 * Origin nor Host on it, so a web page on any local origin could drive it over WebSocket, and over HTTP after DNS
 * rebinding: move its clock, send transactions from contract addresses. The rail therefore
 *  1. puts that listener on a port browsers refuse to connect to: the Fetch standard's "bad ports"
 *     (https://fetch.spec.whatwg.org/#port-blocking, read 24 Nov 2026), which govern fetch, navigation and WebSocket
 *     alike and apply whatever host name a page uses;
 *  2. talks to Anvil only over its IPC socket (`--ipc`), in a folder that only this operating-system user may enter
 *     (0700), the socket itself 0600;
 *  3. leaves the vendored release's clients unchanged: they still address the chain as http://127.0.0.1:<port>, and
 *     routeChain() answers exactly that origin over the socket. Node's own fetch refuses bad ports as browsers do, so a
 *     request routeChain() does not answer fails; it never falls through to the listener.
 * What this does not do: a program that is not a browser (curl, cast) and any other account on this computer can still
 * reach the listener, and Anvil has no credential to ask for. Only a chain with no TCP listener, or one in its own network
 * namespace or container, closes that (SECURITY.md section 8).
 */
import { chmodSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { connect, createServer as createSocketServer, type Socket } from "node:net";

/**
 * Ports that the Fetch standard blocks and that Node's fetch (undici) was seen to refuse ("bad port"; checked by
 * chain/test/anvil-cors.test.ts). Ports a browser policy can re-allow (Chrome's ExplicitlyAllowedNetworkPorts: 554,
 * 989, 990, 6566, 10080) and the ports of services a computer commonly runs (ssh, mail, DNS, file sharing) are left out.
 * Those from 1024 up come first (any user may bind them); the lower ones follow for systems that let a user bind them
 * (macOS since 10.14, most containers).
 */
export const BROWSER_BLOCKED_PORTS: readonly number[] = [
  6665, 6666, 6667, 6668, 6669, 6679, 6697, 4190, 3659, 4045, 1719, 1720, 1723, 5060, 5061, 2049, 6000,
  1, 7, 9, 11, 13, 15, 17, 19, 37, 42, 43, 77, 79, 87, 95, 101, 102, 103, 104, 109, 113, 115, 117, 119, 179, 427, 512, 513, 514, 515, 526, 530, 531, 532, 540, 556, 563, 601,
];
export const isBrowserBlocked = (port: number): boolean => BROWSER_BLOCKED_PORTS.includes(port);

type Pending = { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: NodeJS.Timeout };

/** JSON-RPC over Anvil's IPC socket: one connection, requests matched to answers by an id of its own. */
export class ChainSocket {
  readonly path: string;
  #sock: Socket | null = null;
  #opening: Promise<Socket> | null = null;
  #chunks: Buffer[] = [];
  #seq = 0;
  #pending = new Map<number, Pending>();
  #closed = false;
  constructor(path: string) {
    this.path = path;
  }

  #open(): Promise<Socket> {
    if (this.#closed) return Promise.reject(new Error("The local chain's socket was closed by the rail."));
    if (this.#sock) return Promise.resolve(this.#sock);
    this.#opening ??= new Promise<Socket>((resolve, reject) => {
      const s = connect(this.path);
      // an idle connection does not keep a process alive (a release script must still end when its work is done);
      // a request in flight does (#hold)
      s.once("connect", () => { this.#sock = s; this.#opening = null; s.unref(); resolve(s); });
      // before the connection: the caller is told; after it: "close" follows and fails whatever was waiting
      s.on("error", (e) => { if (this.#sock !== s) { this.#opening = null; reject(e); } });
      s.on("data", (d: Buffer) => this.#read(d));
      s.on("close", () => {
        if (this.#sock === s) this.#sock = null;
        this.#chunks = [];
        for (const [id, p] of this.#pending) { clearTimeout(p.timer); p.reject(new Error("The local chain's socket closed before it answered.")); this.#pending.delete(id); }
      });
    });
    return this.#opening;
  }

  /** Answers are one JSON value per line; a large one (a state dump) arrives in many pieces. */
  #read(d: Buffer) {
    let start = 0;
    for (let i = d.indexOf(10); i !== -1; i = d.indexOf(10, start)) {
      this.#chunks.push(d.subarray(start, i));
      const line = Buffer.concat(this.#chunks).toString("utf8");
      this.#chunks = [];
      start = i + 1;
      let msg: { id?: unknown };
      try { msg = JSON.parse(line) as { id?: unknown }; } catch { continue; }
      const p = typeof msg.id === "number" ? this.#pending.get(msg.id) : undefined;
      if (!p) continue;
      this.#pending.delete(msg.id as number);
      clearTimeout(p.timer);
      p.resolve(msg);
    }
    if (start < d.length) this.#chunks.push(d.subarray(start));
  }

  /** Sends one JSON-RPC request and returns Anvil's whole answer, with the caller's own id put back. */
  async request(message: { id?: unknown; [k: string]: unknown }, timeoutMs = 20_000, signal?: AbortSignal | null): Promise<Record<string, unknown>> {
    signal?.throwIfAborted();
    const s = await this.#open();
    const id = ++this.#seq;
    const answer = await new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => { this.#pending.delete(id); reject(new Error(`The local chain did not answer ${String(message.method)} within ${timeoutMs} ms.`)); }, timeoutMs);
      const onAbort = () => { clearTimeout(timer); this.#pending.delete(id); reject(signal!.reason instanceof Error ? signal!.reason : new DOMException("aborted", "AbortError")); };
      signal?.addEventListener("abort", onAbort, { once: true });
      this.#pending.set(id, { resolve: (v) => { signal?.removeEventListener("abort", onAbort); resolve(v); }, reject: (e) => { signal?.removeEventListener("abort", onAbort); reject(e); }, timer });
      s.ref();
      s.write(`${JSON.stringify({ ...message, id })}\n`);
    }).finally(() => { if (this.#pending.size === 0) this.#sock?.unref(); });
    return { ...(answer as Record<string, unknown>), id: message.id ?? null };
  }

  /** A JSON-RPC call that returns its result or throws Anvil's error message, as Anvil.rpc did over HTTP. */
  async rpc(method: string, params: unknown[] = [], timeoutMs = 20_000): Promise<unknown> {
    const a = (await this.request({ jsonrpc: "2.0", id: 1, method, params }, timeoutMs)) as { result?: unknown; error?: { message?: string } };
    if (a.error) throw new Error(`${method}: ${a.error.message ?? "rpc error"}`);
    return a.result;
  }

  close() {
    this.#closed = true;
    this.#sock?.destroy();
    this.#sock = null;
  }
}

// ------------------------------------------------------------------------------------------------- routed fetch
const routes = new Map<string, ChainSocket>();
let networkFetch: typeof fetch | null = null;

/**
 * From now on, in this process, an HTTP request to `url`'s origin (http://127.0.0.1:<blocked port>) is answered by
 * Anvil over `socketPath` instead. Every other request goes to the network unchanged.
 */
export function routeChain(url: string, socketPath: string): ChainSocket {
  const u = new URL(url);
  if (u.protocol !== "http:" || u.hostname !== "127.0.0.1" || !isBrowserBlocked(Number(u.port))) throw new Error(`refused to route ${url}: only http://127.0.0.1 on a port browsers refuse is the chain's address`);
  let s = routes.get(u.origin);
  if (!s || s.path !== socketPath) { s?.close(); s = new ChainSocket(socketPath); routes.set(u.origin, s); }
  if (!networkFetch) { networkFetch = globalThis.fetch; globalThis.fetch = routedFetch; }
  return s;
}
export function unrouteChain(url: string, socketPath?: string): void {
  const origin = new URL(url).origin;
  const s = routes.get(origin);
  if (!s || (socketPath !== undefined && s.path !== socketPath)) return;
  s.close();
  routes.delete(origin);
}
export const isRouted = (url: string): boolean => routes.has(new URL(url).origin);

// ------------------------------------------------------------------------------------------------ receipts, looked for often
/**
 * How long a client of the local chain waits before it looks again for a transaction's receipt, once its first look
 * (made as soon as the chain accepts the transaction) found none. viem's default is 4 s (createClient: half of a 12 s
 * block time, at most 4 s), made for a public chain. Anvil mines a transaction a few milliseconds after accepting it, and
 * later as its state grows (measured 25 Nov 2026 on Anvil 1.7.1: 90th percentile from send to receipt 2.5 ms over the
 * first 50 deployments, 9 to 11 ms after 150, over the socket and over HTTP alike), so the first look missed more and
 * more often and each miss cost 4 s. In the browser suite's late journeys a wallet's set-up, about twenty transactions,
 * then took up to two minutes, and every other operation waited behind it on the single writer.
 */
export const LOCAL_RECEIPT_POLL_MS = 100;

type ReceiptWaiter = { waitForTransactionReceipt: (args: { hash: `0x${string}`; pollingInterval?: number }) => Promise<unknown> };
/**
 * Gives a vendored chain client (the release's Chain$, unchanged) receipt waits that look again every `ms`: its
 * deploy, send and sendExpectingRevert call `pub.waitForTransactionReceipt`, and a caller's own interval still wins.
 * Setting the client's `pollingInterval` instead would change nothing: viem binds each action to the client as created.
 */
export function quickReceipts<C extends { pub: unknown }>(c: C, ms: number = LOCAL_RECEIPT_POLL_MS): C {
  const pub = c.pub as ReceiptWaiter;
  const wait = pub.waitForTransactionReceipt;
  pub.waitForTransactionReceipt = (args) => wait({ pollingInterval: ms, ...args });
  return c;
}

async function routedFetch(input: string | URL | Request, init?: RequestInit): Promise<Response> {
  const href = input instanceof Request ? input.url : String(input);
  let origin = "";
  try { origin = new URL(href).origin; } catch { /* not a URL: the network fetch reports it */ }
  const s = routes.get(origin);
  if (!s) return networkFetch!(input, init);
  const method = (init?.method ?? (input instanceof Request ? input.method : "GET")).toUpperCase();
  if (method !== "POST") return new Response("JSON-RPC over POST only", { status: 405 });
  const body = init?.body != null ? await new Response(init.body).text() : input instanceof Request ? await input.text() : "";
  let message: unknown;
  try { message = JSON.parse(body); } catch { return Response.json({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } }); }
  try {
    const one = (m: unknown) => s.request(m as { id?: unknown }, 120_000, init?.signal);
    const answer = Array.isArray(message) ? await Promise.all(message.map(one)) : await one(message);
    return new Response(JSON.stringify(answer), { status: 200, headers: { "content-type": "application/json" } });
  } catch (e) {
    if (e instanceof Error && (e.name === "AbortError" || e.name === "TimeoutError")) throw e;
    // what fetch throws when nothing answers, so a client retries or reports it exactly as before
    throw new TypeError("fetch failed", { cause: e });
  }
}

// ------------------------------------------------------------------------------------------------ a guarded front
/**
 * For clients this module cannot reach in their own process: the release's scripted economy starts its services with an
 * allowlisted environment (vendor/agent/scripts/live.ts spawnRole), so they can only be given an address. They get this
 * front on 127.0.0.1:`port`, which answers JSON-RPC from the chain's socket and refuses what a web page can send: any
 * WebSocket upgrade, any request that carries an Origin, Sec-Fetch-Site or Sec-Fetch-Dest header (browsers add them to
 * every request of a page; Node's fetch sends none of the three, only Sec-Fetch-Mode), any Host but 127.0.0.1:`port` or
 * localhost:`port` (DNS rebinding), and anything but a JSON POST of at most 8 MB.
 */
export function startChainGuard(port: number, socketPath: string): Promise<Server> {
  const chain = new ChainSocket(socketPath);
  const server = createServer((req, res) => {
    const host = String(req.headers.host ?? "").toLowerCase();
    const fromPage = req.headers.origin !== undefined || req.headers["sec-fetch-site"] !== undefined || req.headers["sec-fetch-dest"] !== undefined;
    if (req.method !== "POST" || fromPage || (host !== `127.0.0.1:${port}` && host !== `localhost:${port}`) || !/^application\/json\b/i.test(String(req.headers["content-type"] ?? ""))) {
      res.writeHead(403, { "content-type": "text/plain" }).end("refused: this chain answers only local programs");
      req.resume();
      return;
    }
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (d: Buffer) => { size += d.length; if (size > 8 * 1024 * 1024) { res.writeHead(413).end(); req.destroy(); } else chunks.push(d); });
    req.on("end", async () => {
      if (res.writableEnded) return;
      let message: unknown;
      try { message = JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch { res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } })); return; }
      try {
        const one = (m: unknown) => chain.request(m as { id?: unknown }, 120_000);
        const answer = Array.isArray(message) ? await Promise.all(message.map(one)) : await one(message);
        res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(answer));
      } catch (e) { res.writeHead(502, { "content-type": "text/plain" }).end(e instanceof Error ? e.message : "the chain did not answer"); }
    });
  });
  server.on("upgrade", (_req, socket) => socket.destroy());
  server.on("close", () => chain.close());
  return new Promise((ok, fail) => { server.once("error", fail); server.listen(port, "127.0.0.1", () => ok(server)); });
}

// ------------------------------------------------------------------------------------------------ a read-only door
/**
 * What a reader of the chain asks (R14). The co-signer certifies from what it reads: blocks, calls, logs, code, balances,
 * storage, receipts. Nothing here sends a transaction, signs, moves Anvil's clock, balances, code or state, impersonates
 * an account or keeps a filter on the chain. A name not listed is refused.
 */
export const READ_ONLY_METHODS: ReadonlySet<string> = new Set([
  "eth_chainId", "net_version", "web3_clientVersion", "eth_blockNumber", "eth_getBlockByNumber", "eth_getBlockByHash", "eth_call", "eth_estimateGas",
  "eth_getLogs", "eth_getCode", "eth_getBalance", "eth_getStorageAt", "eth_getTransactionCount", "eth_getTransactionByHash", "eth_getTransactionReceipt",
  "eth_gasPrice", "eth_maxPriorityFeePerGas", "eth_feeHistory", "eth_getProof",
]);

export interface ReadOnlyDoor { path: string; forwarded(): number; refused(): string[]; close(): Promise<void> }

/**
 * The chain's read-only door (R14): a second socket, at `doorPath`, that speaks as Anvil's own does (one JSON value per
 * line) and forwards only READ_ONLY_METHODS to the chain's socket at `socketPath`.
 *
 * Why it exists. The chain's own socket is in a folder only the wallet service's user may enter (F-14 above), and in the
 * deployed image the co-signer runs as another user (R13 review fix F3), who must not enter that folder: Anvil has no
 * credential, so its socket is full control of the chain. The two together left the co-signer unable to read the chain,
 * and nothing it certifies could be paid (found 25 Nov 2026). The co-signer is given this door instead: a narrower way in
 * than it had before F3, and the only one it is given or uses. Through the door it can read the chain and change nothing.
 * The door is not a confinement: Anvil's loopback TCP listener (above) still answers any local user, the co-signer's
 * included, with full control and no credential (RISK-114). Only a chain with no TCP listener, or one in its own network
 * namespace, closes that; scripts/deploy/isolation-check.ts reports it as a LIMIT line.
 *
 * Who can open it: the socket is 0660 in the folder it is made in. The container's entrypoint makes that folder the
 * wallet service's, group the co-signer's, set-group-id (2750), so the socket's group is the co-signer's and no other
 * user reaches it. A request that is not one JSON-RPC call by name (a batch, another value) is refused; a line is at most
 * 8 MB. `refused()` lists the last 256 methods refused, so a test can show the co-signer needs none of them. At most 256
 * calls wait on the chain at once; one more is answered "busy" (-32005), so no user of the door can grow the wallet
 * service's memory without bound (review of the R14 fix, L1).
 */
export function startReadOnlyDoor(doorPath: string, socketPath: string): Promise<ReadOnlyDoor> {
  const chain = new ChainSocket(socketPath);
  let forwarded = 0;
  const refused: string[] = [];
  const refuse = (name: string): void => { refused.push(name); if (refused.length > 256) refused.splice(0, refused.length - 256); };
  let waiting = 0;
  const clients = new Set<Socket>();
  const answer = (c: Socket, m: unknown): void => { if (!c.destroyed) c.write(`${JSON.stringify(m)}\n`); };
  const handle = async (c: Socket, line: string): Promise<void> => {
    let m: { id?: unknown; method?: unknown } | null;
    try { m = JSON.parse(line) as { id?: unknown; method?: unknown }; } catch { answer(c, { jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } }); return; }
    if (!m || typeof m !== "object" || Array.isArray(m) || typeof m.method !== "string") { refuse("(not a single call)"); answer(c, { jsonrpc: "2.0", id: null, error: { code: -32600, message: "The chain's read-only door takes one JSON-RPC call at a time." } }); return; }
    if (!READ_ONLY_METHODS.has(m.method)) { refuse(m.method.slice(0, 80)); answer(c, { jsonrpc: "2.0", id: m.id ?? null, error: { code: -32601, message: `${m.method.slice(0, 80)}: not available on the chain's read-only door.` } }); return; }
    if (waiting >= 256) { answer(c, { jsonrpc: "2.0", id: m.id ?? null, error: { code: -32005, message: "The chain's read-only door is busy; ask again." } }); return; }
    forwarded++;
    waiting++;
    try { answer(c, await chain.request(m as { id?: unknown }, 120_000)); }
    catch { answer(c, { jsonrpc: "2.0", id: m.id ?? null, error: { code: -32603, message: "The local chain did not answer." } }); }
    finally { waiting--; }
  };
  const server = createSocketServer((c) => {
    clients.add(c);
    let chunks: Buffer[] = [], size = 0;
    c.on("error", () => c.destroy());
    c.on("close", () => clients.delete(c));
    c.on("data", (d: Buffer) => {
      let start = 0;
      for (let i = d.indexOf(10); i !== -1; i = d.indexOf(10, start)) {
        chunks.push(d.subarray(start, i));
        const line = Buffer.concat(chunks).toString("utf8");
        chunks = []; size = 0; start = i + 1;
        if (line.trim()) void handle(c, line);
      }
      if (start < d.length) { chunks.push(d.subarray(start)); size += d.length - start; if (size > 8 * 1024 * 1024) c.destroy(); }
    });
  });
  const close = (): Promise<void> => new Promise((done) => { for (const c of clients) c.destroy(); chain.close(); server.close(() => { rmSync(doorPath, { force: true }); done(); }); });
  return new Promise((ok, fail) => {
    rmSync(doorPath, { force: true }); // a socket left by a service that was killed
    server.once("error", fail);
    server.listen(doorPath, () => {
      try { chmodSync(doorPath, 0o660); } catch (e) { server.close(); fail(e as Error); return; }
      ok({ path: doorPath, forwarded: () => forwarded, refused: () => [...refused], close });
    });
  });
}
