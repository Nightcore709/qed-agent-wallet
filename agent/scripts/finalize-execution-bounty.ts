/**
 * Appends Run 4b (the execution bounty) to Run 4's public evidence:
 *   evidence/shadow-execution-bounty/manifest.json + relay/receipts-11155111-execution-bounty.json
 *   → evidence/ethereum-sepolia/execution/{manifest,receipts}.json
 * Every public receipt must match the replica (status + logs); blocks, gas and timestamps come from Sepolia.
 */
import { readFileSync, writeFileSync } from "node:fs";

const OUT = "evidence/ethereum-sepolia/execution";
const outbox = JSON.parse(readFileSync("relay/outbox-11155111-execution-bounty.json", "utf8"));
const rec = JSON.parse(readFileSync("relay/receipts-11155111-execution-bounty.json", "utf8"));
const shadow = JSON.parse(readFileSync(process.env.SHADOW_DIR ?? "evidence/shadow-execution-bounty/manifest.json", "utf8"));
const manifest = JSON.parse(readFileSync(`${OUT}/manifest.json`, "utf8"));
const receipts = JSON.parse(readFileSync(`${OUT}/receipts.json`, "utf8"));
const byHash = new Map<string, any>(rec.transactions.map((r: any) => [r.hash.toLowerCase(), r]));
if (rec.transactions.length !== outbox.length) throw new Error("receipt count mismatch");
for (const t of outbox) {
  const r = byHash.get(t.hash.toLowerCase());
  if (!r || r.status !== t.shadowStatus || !r.logsMatch) throw new Error(`receipt mismatch for ${t.hash}`);
}
if (manifest.steps.some((s: any) => s.id === "XB1")) throw new Error("already appended");
for (const s of shadow.steps) {
  const r = byHash.get(s.tx.hash.toLowerCase());
  s.tx.replica = { blockNumber: s.tx.blockNumber, gasUsed: s.tx.gasUsed };
  s.tx.blockNumber = String(r.block);
  s.tx.gasUsed = String(r.gasUsed);
  s.tx.timestamp = r.timestamp;
  manifest.steps.push(s);
}
manifest.contracts.executionBounty = shadow.contracts.executionBounty;
manifest.actors.lp4 = shadow.actors.lp4;
manifest.bounty = { ...shadow.final, deployBlock: String(byHash.get(shadow.steps[0].tx.hash.toLowerCase()).block) };
const blocks = rec.transactions.map((r: any) => r.block);
manifest.sepolia.lastBlock = Math.max(manifest.sepolia.lastBlock, ...blocks);
manifest.sepolia.transactions += rec.transactions.length;
manifest.sepolia.reverted += rec.transactions.filter((r: any) => r.status === "reverted").length;
manifest.sepolia.relayComparison = `${manifest.sepolia.transactions}/${manifest.sepolia.transactions} receipts matched the replica (status + logs; EIP-7708 system logs excluded); Run 4b replayed Run 4's signed bytes on the replica first`;
const label = new Map<string, string>(shadow.steps.map((s: any) => [s.tx.hash.toLowerCase(), `${s.id} · ${s.title}`]));
receipts.transactions.push(...rec.transactions.map((r: any) => ({ ...r, i: receipts.transactions.length + r.i, label: label.get(r.hash.toLowerCase()) ?? "setup" })));
writeFileSync(`${OUT}/manifest.json`, JSON.stringify(manifest, null, 2));
writeFileSync(`${OUT}/receipts.json`, JSON.stringify(receipts, null, 2));
console.log(`appended ${shadow.steps.length} steps; ${manifest.sepolia.transactions} receipts in ${OUT}`);
