/**
 * F-14 (security review R13, docs/SECURITY-REVIEW-R13.md) and standards gap G-C4: no web page may use the local chain.
 *
 * Anvil 1.7.1 always opens a TCP listener (an empty --host is refused) and checks neither Origin nor Host on it, so
 * --no-cors alone left it open to a WebSocket from any local page and to HTTP after DNS rebinding. The rail now puts
 * that listener on a port the Fetch standard blocks and drives Anvil over its IPC socket (chain/rail/chain-socket.ts).
 * These checks take a client that follows the browser rules (Node's fetch and WebSocket implement the same WHATWG
 * standards) and show that it reaches nothing; scripts/security.ts R14 does the same from Chrome. A control Anvil,
 * started as the rail started it before R13, shows what the assertions catch: the same WebSocket moves its clock.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { statSync } from "node:fs";
import { connect } from "node:net";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { freshDir } from "./helpers.ts";
import { Anvil } from "../rail/anvil.ts";
import { BROWSER_BLOCKED_PORTS, isBrowserBlocked, routeChain } from "../rail/chain-socket.ts";

const BIN = join(homedir(), ".foundry", "bin", "anvil");
/** The port of the control Anvil: an ordinary one (QED_CHAIN_TEST_CONTROL_PORT, else 18761). */
const CONTROL = Number(process.env.QED_CHAIN_TEST_CONTROL_PORT ?? 18761);
const YEAR = "0x1e13380"; // 31,536,000 s

/** What a page on another local origin does over WebSocket: move the clock by a year and mine. */
async function wsDrive(url: string): Promise<{ opened: boolean; answers: string[] }> {
  return new Promise((done) => {
    const answers: string[] = [];
    let opened = false;
    let ws: WebSocket;
    try { ws = new WebSocket(url); } catch (e) { done({ opened, answers: [String(e)] }); return; }
    const t = setTimeout(() => { try { ws.close(); } catch { /* closed */ } done({ opened, answers }); }, 4_000);
    ws.onopen = () => {
      opened = true;
      ws.send(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "evm_increaseTime", params: [YEAR] }));
      ws.send(JSON.stringify({ jsonrpc: "2.0", id: 2, method: "evm_mine", params: [] }));
    };
    ws.onmessage = (m) => { answers.push(String(m.data)); if (answers.length === 2) { clearTimeout(t); ws.close(); done({ opened, answers }); } };
    ws.onerror = () => { /* onclose follows */ };
    ws.onclose = () => { clearTimeout(t); done({ opened, answers }); };
  });
}
/** A raw HTTP request, as curl sends it: not a browser, so no port rule applies. */
function rawPost(port: number, host: string, body: string): Promise<string> {
  return new Promise((resolve) => {
    const s = connect(port, "127.0.0.1", () => s.end(`POST / HTTP/1.1\r\nHost: ${host}\r\nOrigin: https://evil.example\r\nContent-Type: application/json\r\nContent-Length: ${Buffer.byteLength(body)}\r\nConnection: close\r\n\r\n${body}`));
    let out = "";
    s.on("data", (d) => { out += d; });
    s.on("close", () => resolve(out));
    s.on("error", (e) => resolve(`error ${e.message}`));
  });
}
const clock = async (rpc: (m: string, p?: unknown[]) => Promise<unknown>) => Number(((await rpc("eth_getBlockByNumber", ["latest", false])) as { timestamp: string }).timestamp);

test("every port the rail may give Anvil is one the Fetch standard blocks: Node's fetch refuses each before connecting, whatever the host name", async () => {
  assert.ok(BROWSER_BLOCKED_PORTS.length >= 17);
  for (const p of BROWSER_BLOCKED_PORTS) {
    for (const host of ["127.0.0.1", "localhost", "rebind.evil.example"]) {
      const e = (await fetch(`http://${host}:${p}/`, { method: "POST" }).then(() => null, (x: unknown) => x)) as { cause?: { message?: string } } | null;
      assert.match(String(e?.cause?.message), /bad port/, `${host}:${p}`);
    }
  }
  assert.ok(!isBrowserBlocked(8546) && !isBrowserBlocked(CONTROL), "the old chain port and the control port are ordinary ones");
  assert.throws(() => new Anvil({ bin: BIN, stateFile: "/nonexistent/s.hex", pidFile: "/nonexistent/anvil.pid", port: 8546 }), /can be reached by a web page/);
  assert.throws(() => routeChain("http://127.0.0.1:8546", "/nonexistent.ipc"), /refused to route/);
});

test("F-14: the rail's chain listens only on a blocked port and answers over an owner-only socket; a WebSocket and a rebinding request reach nothing and its clock stays; a control Anvil with the old flags is driven", { timeout: 90_000 }, async () => {
  const dir = freshDir("cors");
  const a = new Anvil({ bin: BIN, stateFile: join(dir, "s.hex"), pidFile: join(dir, "anvil.pid") });
  await a.start();
  try {
    const cmd = execFileSync("ps", ["-p", String(a.pid), "-o", "command="]).toString();
    assert.match(cmd, /--no-cors/);
    assert.ok(cmd.includes(`--ipc ${a.socketPath}`), cmd);
    assert.ok(isBrowserBlocked(a.port), `listens on ${a.port}`);
    // the only TCP listener of the chain's process is that one port
    const listening = execFileSync("lsof", ["-nP", "-a", "-p", String(a.pid), "-iTCP", "-sTCP:LISTEN", "-Fn"]).toString().split("\n").filter((l) => l.startsWith("n")).map((l) => l.slice(1));
    assert.deepEqual(listening, [`127.0.0.1:${a.port}`]);
    // owner-only: the socket's folder 0700, the socket 0600, both this user's
    const folder = statSync(dirname(a.socketPath)), sock = statSync(a.socketPath);
    assert.equal(folder.mode & 0o777, 0o700);
    assert.equal(sock.mode & 0o777, 0o600);
    assert.equal(folder.uid, process.getuid!());
    // the rail (and the vendored clients in its process) reach the chain over the socket only
    assert.equal(Number(await a.rpc("eth_chainId")), 31337);
    const viaRoute = (await (await fetch(a.url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 7, method: "eth_chainId", params: [] }) })).json()) as { id: number; result: string };
    assert.deepEqual([viaRoute.id, Number(viaRoute.result)], [7, 31337]);
    const t0 = await clock((m, p) => a.rpc(m, p));
    // a page on another local origin: WebSocket to the listener, by address and by name
    for (const url of [`ws://127.0.0.1:${a.port}`, `ws://localhost:${a.port}`]) {
      const w = await wsDrive(url);
      assert.equal(w.opened, false, `${url} opened: ${w.answers.join(" ")}`);
    }
    // DNS rebinding: a page whose own name now resolves to 127.0.0.1 posts to its own origin on that port
    const rebind = (await fetch(`http://rebind.evil.example:${a.port}/`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "evm_increaseTime", params: [YEAR] }) }).then(() => null, (x: unknown) => x)) as { cause?: { message?: string } } | null;
    assert.match(String(rebind?.cause?.message), /bad port/);
    await a.rpc("evm_mine", []);
    assert.ok((await clock((m, p) => a.rpc(m, p))) - t0 < 3600, "the chain's clock did not move");
    // What remains (SECURITY.md section 8): a program that is not a browser still reaches the listener, as curl does.
    const raw = await rawPost(a.port, `rebind.evil.example:${a.port}`, JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_chainId", params: [] }));
    assert.match(raw, /"result":"0x7a69"/, "Anvil cannot drop its TCP listener; only non-browser local programs reach it");
  } finally { await a.stop(); }
  assert.throws(() => statSync(a.endpointFile), /ENOENT/, "the endpoint record is removed with the chain");

  // control: an Anvil started as the rail started it before R13 (--no-cors, an ordinary port): driven by the same WebSocket
  const ctl = spawn(BIN, ["--host", "127.0.0.1", "--port", String(CONTROL), "--chain-id", "31337", "--no-cors", "--silent"], { stdio: "ignore" });
  try {
    const rpc = async (method: string, params: unknown[] = []) => ((await (await fetch(`http://127.0.0.1:${CONTROL}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) })).json()) as { result: unknown }).result;
    for (let i = 0; i < 100; i++) { try { await rpc("eth_chainId"); break; } catch { await sleep(100); } }
    assert.equal(ctl.exitCode, null, `the control Anvil is running (port ${CONTROL} was free); choose another with QED_CHAIN_TEST_CONTROL_PORT`);
    const c0 = await clock(rpc);
    const w = await wsDrive(`ws://127.0.0.1:${CONTROL}`);
    assert.equal(w.opened, true, "the control is reachable: the assertions above are meaningful");
    const moved = (await clock(rpc)) - c0;
    assert.ok(moved >= 31_536_000, `the control's clock moved by a year (moved ${moved} s; answers ${w.answers.join(" ")})`);
  } finally { ctl.kill("SIGKILL"); }
});

test("a restarted chain keeps its port and its socket, so every client already routed keeps working", { timeout: 60_000 }, async () => {
  const dir = freshDir("cors-restart");
  const a = new Anvil({ bin: BIN, stateFile: join(dir, "s.hex"), pidFile: join(dir, "anvil.pid") });
  await a.start();
  try {
    const [port, socket] = [a.port, a.socketPath];
    process.kill(a.pid!, "SIGKILL");
    for (let i = 0; i < 50 && a.status === "up"; i++) await sleep(100);
    await a.start();
    assert.deepEqual([a.port, a.socketPath], [port, socket]);
    assert.equal(Number(await a.rpc("eth_chainId")), 31337);
  } finally { await a.stop(); }
});
