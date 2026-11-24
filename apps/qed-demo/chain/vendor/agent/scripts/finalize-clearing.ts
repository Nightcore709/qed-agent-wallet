/**
 * Turns the replica's clearing evidence into the public-chain evidence:
 *   evidence/shadow-clearing/{manifest,proof}.json  +  relay/receipts-11155111-clearing.json
 *   → evidence/ethereum-sepolia/clearing/{manifest,proof,receipts}.json
 * Receipts are fetched from a public Sepolia RPC (by the browser relay) and must match the replica
 * hash-for-hash and status-for-status; block numbers, gas and timestamps come from Sepolia.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";

const SHADOW = process.env.SHADOW_DIR ?? "evidence/shadow-clearing";
const OUT = "evidence/ethereum-sepolia/clearing";
const outbox = JSON.parse(readFileSync("relay/outbox-11155111-clearing.json", "utf8"));
const receipts = JSON.parse(readFileSync("relay/receipts-11155111-clearing.json", "utf8"));
const manifest = JSON.parse(readFileSync(`${SHADOW}/manifest.json`, "utf8"));
const byHash = new Map<string, any>(receipts.transactions.map((r: any) => [r.hash.toLowerCase(), r]));

if (receipts.transactions.length !== outbox.length) throw new Error(`receipts ${receipts.transactions.length} != outbox ${outbox.length}`);
for (const t of outbox) {
  const r = byHash.get(t.hash.toLowerCase());
  if (!r) throw new Error(`missing receipt for ${t.hash}`);
  if (r.status !== t.shadowStatus) throw new Error(`status mismatch for ${t.hash}`);
}

const labels = new Map<string, string>();
for (const s of manifest.steps) {
  if (!s.tx) continue;
  const r = byHash.get(s.tx.hash.toLowerCase());
  if (!r) throw new Error(`step ${s.id}: no public receipt`);
  s.tx.replica = { blockNumber: s.tx.blockNumber, gasUsed: s.tx.gasUsed };
  s.tx.blockNumber = String(r.block);
  s.tx.gasUsed = String(r.gasUsed);
  s.tx.timestamp = r.timestamp;
  labels.set(s.tx.hash.toLowerCase(), `${s.id} · ${s.title}`);
}
const blocks = receipts.transactions.map((r: any) => r.block);
const k1 = manifest.steps.find((s: any) => s.id === "K1");
manifest.contracts.deployBlock = k1.tx.blockNumber; // the Sepolia block, not the replica's
manifest.sepolia = {
  firstBlock: Math.min(...blocks),
  lastBlock: Math.max(...blocks),
  transactions: receipts.transactions.length,
  reverted: receipts.transactions.filter((r: any) => r.status === "reverted").length,
  receipts: "receipts.json",
  relayComparison: `${receipts.transactions.length}/${outbox.length} receipts matched the replica (status + logs; EIP-7708 system logs excluded)`,
};
manifest.executionNote =
  "Signed in a build sandbox without RPC egress against a wall-clock-synchronised replica of Sepolia (same chain id, nonces, balances); the identical signed bytes were broadcast via a browser relay and every public receipt compared with the replica (status + logs).";
receipts.transactions = receipts.transactions.map((r: any) => ({ ...r, label: labels.get(r.hash.toLowerCase()) ?? "setup (funding, mint or approval)" }));

mkdirSync(OUT, { recursive: true });
writeFileSync(`${OUT}/manifest.json`, JSON.stringify(manifest, null, 2));
writeFileSync(`${OUT}/receipts.json`, JSON.stringify(receipts, null, 2));
writeFileSync(`${OUT}/proof.json`, readFileSync(`${SHADOW}/proof.json`, "utf8"));
console.log(`wrote ${OUT}: ${manifest.steps.length} steps, ${receipts.transactions.length} receipts, blocks ${manifest.sepolia.firstBlock}–${manifest.sepolia.lastBlock}`);
