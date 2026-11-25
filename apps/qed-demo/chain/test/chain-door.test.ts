/**
 * R14: the chain's read-only door (rail/chain-socket.ts startReadOnlyDoor), the co-signer's way to the chain when it runs
 * as another user (the deployed image). The chain's own socket is in a folder only the wallet service's user may enter
 * (F-14), so a co-signer running as its own user (F3) could not read the chain at all, and nothing it must certify could
 * be paid (found on 25 Nov 2026). The door answers what a reader needs and refuses everything else before it reaches the
 * chain: sending a transaction, Anvil's own controls (balances, clocks, impersonation, state), signing, filters, batches.
 * It is checked here against a stand-in for the chain that records what reaches it.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ChainSocket, READ_ONLY_METHODS, startReadOnlyDoor } from "../rail/chain-socket.ts";

/** A stand-in for Anvil's IPC socket: one JSON value per line, answered with the method's name, every method recorded. */
function standIn(path: string, seen: string[]): Promise<Server> {
  const server = createServer((c) => {
    let buf = "";
    c.on("data", (d) => {
      buf += d.toString("utf8");
      for (let i = buf.indexOf("\n"); i !== -1; i = buf.indexOf("\n")) {
        const m = JSON.parse(buf.slice(0, i)) as { id: number; method: string };
        buf = buf.slice(i + 1);
        seen.push(m.method);
        c.write(`${JSON.stringify({ jsonrpc: "2.0", id: m.id, result: `answered ${m.method}` })}\n`);
      }
    });
  });
  return new Promise((ok) => server.listen(path, () => ok(server)));
}

test("the read-only door forwards a reader's calls and refuses every call that could change the chain, before it reaches the chain", async () => {
  const dir = mkdtempSync(join(tmpdir(), "qed-door-"));
  const seen: string[] = [];
  const chain = await standIn(join(dir, "anvil.ipc"), seen);
  const door = await startReadOnlyDoor(join(dir, "door.sock"), join(dir, "anvil.ipc"));
  const client = new ChainSocket(door.path);
  try {
    assert.equal(statSync(door.path).mode & 0o777, 0o660, "the door is its owner's and its group's only");
    // what the co-signer's engine asks: answered by the chain, with the caller's own id put back
    for (const method of ["eth_chainId", "eth_blockNumber", "eth_getBlockByNumber", "eth_call", "eth_getLogs", "eth_getCode", "eth_getBalance", "eth_getStorageAt", "eth_getTransactionReceipt"]) {
      assert.ok(READ_ONLY_METHODS.has(method), method);
      assert.deepEqual(await client.request({ jsonrpc: "2.0", id: 41, method, params: [] }), { jsonrpc: "2.0", id: 41, result: `answered ${method}` });
    }
    const forwarded = seen.length;
    // what would change the chain, sign, or hold state on it: refused by name, and the chain never hears of it
    const refused = ["eth_sendRawTransaction", "eth_sendTransaction", "eth_sign", "eth_signTypedData_v4", "personal_sign", "anvil_setBalance", "anvil_setCode", "anvil_setStorageAt", "anvil_impersonateAccount", "anvil_loadState", "anvil_dumpState", "anvil_reset", "anvil_mine", "evm_mine", "evm_increaseTime", "evm_setNextBlockTimestamp", "evm_snapshot", "evm_revert", "hardhat_setBalance", "eth_newFilter", "debug_traceTransaction", "eth_accounts", "no_such_method"];
    for (const method of refused) {
      assert.ok(!READ_ONLY_METHODS.has(method), method);
      const a = (await client.request({ jsonrpc: "2.0", id: 7, method, params: [] })) as { id: unknown; error?: { code: number; message: string }; result?: unknown };
      assert.equal(a.result, undefined, method);
      assert.deepEqual([a.id, a.error?.code], [7, -32601], method);
      assert.match(a.error!.message, new RegExp(`^${method}: `), "the refusal names the method");
    }
    // not a single request: a batch, a value that is not an object, a request with no method name
    for (const bad of [[{ jsonrpc: "2.0", id: 1, method: "eth_chainId" }], "eth_chainId", { jsonrpc: "2.0", id: 1 }, { jsonrpc: "2.0", id: 1, method: 5 }]) {
      const raw = new ChainSocket(door.path);
      // ChainSocket numbers each request itself, so these are written through a plain connection to keep their shape
      const { connect } = await import("node:net");
      const answer = await new Promise<{ error?: { code: number } }>((ok, fail) => { const s = connect(door.path); let b = ""; s.on("data", (d) => { b += d.toString("utf8"); if (b.includes("\n")) { s.destroy(); ok(JSON.parse(b.slice(0, b.indexOf("\n")))); } }); s.on("error", fail); s.write(`${JSON.stringify(bad)}\n`); });
      raw.close();
      assert.equal(answer.error?.code, -32600, JSON.stringify(bad));
    }
    assert.equal(seen.length, forwarded, "nothing refused reached the chain");
    assert.deepEqual([door.forwarded(), door.refused().length], [forwarded, refused.length + 4]);
    assert.ok(door.refused().includes("anvil_setBalance"));
  } finally {
    client.close();
    await door.close();
    await new Promise<void>((r) => chain.close(() => r()));
    rmSync(dir, { recursive: true, force: true });
  }
});
