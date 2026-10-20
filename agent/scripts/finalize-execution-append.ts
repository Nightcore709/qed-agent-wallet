/**
 * Appends a follow-up run (4b: execution bounty, 4c: treasury policy, 4d: the policy as a contract) to Run 4's public evidence:
 *   evidence/shadow-<run>/manifest.json + relay/receipts-11155111-<run>.json
 *   → evidence/ethereum-sepolia/execution/{manifest,receipts}.json (+ the run's decision records)
 *   RUN=execution-bounty | execution-policy | execution-policy-chain  npx tsx agent/scripts/finalize-execution-append.ts
 * Every public receipt must match the replica (status + logs); blocks, gas and timestamps come from Sepolia.
 */
import { cpSync, existsSync, readFileSync, writeFileSync } from "node:fs";

const RUN = process.env.RUN ?? "execution-bounty";
const OUT = "evidence/ethereum-sepolia/execution";
const SHADOW = `evidence/shadow-${RUN}`;
const outbox = JSON.parse(readFileSync(`relay/outbox-11155111-${RUN}.json`, "utf8"));
const rec = JSON.parse(readFileSync(`relay/receipts-11155111-${RUN}.json`, "utf8"));
const shadow = JSON.parse(readFileSync(`${SHADOW}/manifest.json`, "utf8"));
const manifest = JSON.parse(readFileSync(`${OUT}/manifest.json`, "utf8"));
const receipts = JSON.parse(readFileSync(`${OUT}/receipts.json`, "utf8"));
const byHash = new Map<string, any>(rec.transactions.map((r: any) => [r.hash.toLowerCase(), r]));
if (rec.transactions.length !== outbox.length) throw new Error("receipt count mismatch");
for (const t of outbox) {
  const r = byHash.get(t.hash.toLowerCase());
  if (!r || r.status !== t.shadowStatus || !r.logsMatch) throw new Error(`receipt mismatch for ${t.hash}`);
}
const first = shadow.steps[0].id;
if (manifest.steps.some((s: any) => s.id === first)) throw new Error(`${RUN} already appended`);
for (const s of shadow.steps) {
  if (s.tx) {
    const r = byHash.get(s.tx.hash.toLowerCase());
    s.tx.replica = { blockNumber: s.tx.blockNumber, gasUsed: s.tx.gasUsed };
    s.tx.blockNumber = String(r.block);
    s.tx.gasUsed = String(r.gasUsed);
    s.tx.timestamp = r.timestamp;
  }
  for (const a of s.artifacts ?? []) a.path = a.path.replace(SHADOW, OUT);
  manifest.steps.push(s);
}
if (existsSync(`${SHADOW}/records`)) cpSync(`${SHADOW}/records`, `${OUT}/records`, { recursive: true });
Object.assign(manifest.actors, shadow.actors);
if (RUN === "execution-bounty") {
  manifest.contracts.executionBounty = shadow.contracts.executionBounty;
  manifest.bounty = { ...shadow.final, deployBlock: String(byHash.get(shadow.steps[0].tx.hash.toLowerCase()).block) };
}
if (RUN === "execution-policy") manifest.policyRun = { policy: shadow.policy, ticks: shadow.ticks };
if (RUN === "execution-policy-chain") {
  manifest.contracts.treasuryPolicy = shadow.contracts.treasuryPolicy;
  manifest.policyChain = { ...shadow.policyChain, deployBlock: String(byHash.get(shadow.steps[0].tx.hash.toLowerCase()).block) };
}
const blocks = rec.transactions.map((r: any) => r.block);
manifest.sepolia.lastBlock = Math.max(manifest.sepolia.lastBlock, ...blocks);
manifest.sepolia.transactions += rec.transactions.length;
manifest.sepolia.reverted += rec.transactions.filter((r: any) => r.status === "reverted").length;
manifest.sepolia.relayComparison = `${manifest.sepolia.transactions}/${manifest.sepolia.transactions} receipts matched the replica (status + logs; EIP-7708 system logs excluded); Runs 4b–4d first replayed the earlier runs' signed bytes on the replica (4d at their original timestamps)`;
const label = new Map<string, string>(shadow.steps.filter((s: any) => s.tx).map((s: any) => [s.tx.hash.toLowerCase(), `${s.id} · ${s.title}`]));
const base = receipts.transactions.length;
receipts.transactions.push(...rec.transactions.map((r: any) => ({ ...r, i: base + r.i, label: label.get(r.hash.toLowerCase()) ?? "setup" })));
writeFileSync(`${OUT}/manifest.json`, JSON.stringify(manifest, null, 2));
writeFileSync(`${OUT}/receipts.json`, JSON.stringify(receipts, null, 2));
console.log(`appended ${RUN}: ${shadow.steps.length} steps; ${manifest.sepolia.transactions} receipts in ${OUT}`);
