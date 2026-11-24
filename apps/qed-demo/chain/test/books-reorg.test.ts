/**
 * R13: the household's books (server/chain-books.ts) against a real wallet service on a real Anvil, through the
 * reorganisation path that only a fake chain had exercised (server/chain-books.test.ts): a booking whose block is
 * replaced by anvil_reorg is reversed by a new entry (reverseAbove), nothing is deleted, the owner is told, and the books
 * agree with the chain again. The service runs as its own process (serve.ts, multi-tenant, one workspace owned by a
 * software passkey) on port 12487; its chain on a port browsers refuse, reached here over the socket it records
 * (rail/chain-socket.ts).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { key } from "./helpers.ts";
import { RP_ID_HASH, SoftwarePasskey, passkeyApproval } from "./passkey.ts";
import { serviceChain, startService, type Service } from "./service-helper.ts";
import type { Accepted, Job, Proposal } from "../types.ts";

// The server's modules, loaded through variable specifiers: they are the app's code, type-checked by the app's own
// configuration (apps/qed-demo/tsconfig.json), not by this package's (as core.test.ts loads the release's sandbox).
const server = (m: string) => import(join(import.meta.dirname, "..", "..", "server", m)) as Promise<any>;

process.env.QED_OFFLINE = "1";
delete process.env.ANTHROPIC_API_KEY;

const rpcOf = (url: string) => async (method: string, params: unknown[] = []) => {
  const r = (await (await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) })).json()) as { result?: unknown; error?: { message: string } };
  if (r.error) throw new Error(`${method}: ${r.error.message}`);
  return r.result;
};

const WS = "books-home", owner = new SoftwarePasskey();
async function act(s: Service, kind: string, params: Record<string, unknown> = {}): Promise<Job> {
  const p = await s.call<Proposal>("POST", `/workspaces/${WS}/proposals`, { kind, params });
  assert.equal(p.status, 201, JSON.stringify(p.data));
  const a = await s.call<Accepted>("POST", `/workspaces/${WS}/proposals/${p.data.id}/execute`, { approval: passkeyApproval(p.data, [owner]) }, { "Idempotency-Key": key() });
  assert.equal(a.status, 202, JSON.stringify(a.data));
  for (let i = 0; i < 600; i++) {
    const j = (await s.call<Job>("GET", `/workspaces/${WS}/jobs/${a.data.jobId}`)).data;
    if (["done", "failed", "interrupted", "reorged"].includes(j.status)) return j;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error("job did not finish");
}

test("the books on a real chain: a booked conversion whose blocks anvil_reorg replaces is reversed by a new entry, the owner is told, and the books agree with the chain again", { timeout: 300_000 }, async () => {
  const [{ compareChainBooks, syncChainBooks }, { listEntries, verifyLedger }, { saveVault }, { testKeys }, { makeKit }] = await Promise.all(["chain-books.ts", "ledger.ts", "rail.ts", "key-fixture.ts", "testkit.ts"].map(server));
  const keyDir = mkdtempSync(join(tmpdir(), "qed-books-reorg-keys-"));
  const was = { url: process.env.QED_RAIL_URL, token: process.env.QED_RAIL_TOKEN_FILE, keys: process.env.QED_KEY_DIR };
  const s = await startService("books-reorg", 12487, 12488, { env: { QED_RAIL_MODE: "multi-tenant", QED_RAIL_ACCOUNT_DELAY_S: "60", QED_RAIL_ACCOUNT_RECOVERY_DELAY_S: "60" }, workspace: null });
  try {
    process.env.QED_KEY_DIR = testKeys(keyDir).dir;
    process.env.QED_RAIL_URL = `http://127.0.0.1:${s.port}`;
    process.env.QED_RAIL_TOKEN_FILE = join(s.dir, "rail.token");
    assert.equal((await s.call("POST", "/workspaces", { workspaceId: WS, owner: owner.publicKey, rpIdHash: RP_ID_HASH })).status, 201);
    assert.equal((await act(s, "provision")).status, "done");
    assert.equal((await act(s, "mandate", { maxPerPayment: "2500" })).status, "done");

    // the household and its wallet, as the server records them; the books read the service's own movements
    const k = makeKit();
    const now = () => k.clock.now();
    k.clock.advance(Date.now() - k.clock.now()); // the books compare block times with the clock: the real one
    saveVault(k.db, k.userId, { railId: WS, request: { workspaceId: WS, owner: { signers: [], threshold: 1 }, rpIdHash: `0x${"00".repeat(32)}`, origin: "http://localhost:5175" }, credentialIds: [], createdAt: now(), createdBy: k.userId } as never);
    const CFG = { dbPath: join(s.dir, "server-qed.db") };
    const chainEntries = (): { kind: string; ref: string; meta: unknown }[] => listEntries(k.db, k.userId, { limit: 500 }).filter((e: { kind: string }) => e.kind.startsWith("chain-"));

    const conv = await act(s, "convert", { amount: "10" });
    assert.equal(conv.status, "done", conv.error ?? "");
    assert.ok((conv.confirmations?.have ?? 0) >= 2, "the job is done with its confirmations (R7-036)");
    const rpc = rpcOf(serviceChain(s.dir));
    await rpc("evm_mine");
    const first = await compareChainBooks(CFG, k.db, k.userId, now());
    assert.equal(first.state, "agrees", JSON.stringify(first));
    const booked = chainEntries().filter((e) => (e.meta as { txHash?: string }).txHash === conv.result!.tx!.hash);
    assert.ok(booked.length >= 1, "the conversion's movements are booked");

    // the conversion's block and every block after it are replaced by empty ones, deeper than the books' two confirmations
    const latest = Number(await rpc("eth_blockNumber"));
    await rpc("anvil_reorg", [latest - Number(conv.result!.tx!.block) + 1, []]);
    await rpc("evm_mine"); await rpc("evm_mine");
    assert.equal(await rpc("eth_getTransactionReceipt", [conv.result!.tx!.hash]), null);

    const r = await syncChainBooks(CFG, k.db, k.userId, now());
    assert.equal(r.state, "synced");
    assert.equal(r.reversed, booked.length, "each booking of the replaced blocks is reversed");
    const reversals = chainEntries().filter((e) => e.kind === "chain-reversal");
    assert.equal(reversals.length, booked.length);
    for (const b of booked) assert.ok(reversals.some((x) => (x.meta as { reverses?: string }).reverses === b.ref), `the booking ${b.ref} is reversed, not deleted`);
    assert.equal(chainEntries().filter((e) => (e.meta as { txHash?: string }).txHash === conv.result!.tx!.hash && e.kind !== "chain-reversal").length, booked.length, "the original entries stay");
    assert.ok(k.db.get(`SELECT 1 x FROM notices WHERE user_id = ? AND kind = 'chain-reorganised'`, k.userId), "the owner is told");
    assert.deepEqual(verifyLedger(k.db, k.userId), []);
    const after = await compareChainBooks(CFG, k.db, k.userId, now());
    assert.equal(after.state, "agrees", JSON.stringify(after));
    // a second sync reverses nothing more
    assert.equal((await syncChainBooks(CFG, k.db, k.userId, now())).reversed, 0);
  } finally {
    for (const [k, v] of [["QED_RAIL_URL", was.url], ["QED_RAIL_TOKEN_FILE", was.token], ["QED_KEY_DIR", was.keys]] as const) if (v === undefined) delete process.env[k]; else process.env[k] = v;
    await s.stop();
    rmSync(keyDir, { recursive: true, force: true });
  }
});
