/**
 * Renders docs/EVIDENCE.md from the canonical evidence (manifest + public receipts).
 *   npm run evidence:md
 */
import { readFileSync, writeFileSync } from "node:fs";

const EV = process.env.EVIDENCE ?? "evidence/ethereum-sepolia";
const m = JSON.parse(readFileSync(`${EV}/manifest.json`, "utf8"));
const R = JSON.parse(readFileSync(`${EV}/receipts.json`, "utf8"));
const X = m.network.explorer;
const tx = (h: string) => `[\`${h.slice(0, 10)}…${h.slice(-4)}\`](${X}/tx/${h})`;
const addr = (a: string) => `[\`${a}\`](${X}/address/${a})`;
const usd = (x: string | number | bigint) => `${(Number(x) / 1e6).toFixed(2)}`;
const esc = (s: string) => String(s).replace(/\|/g, "\\|");
const iso = (t: number) => new Date(t * 1000).toISOString().replace(".000Z", "Z");

const rcpt: Record<string, any> = Object.fromEntries(R.transactions.map((r: any) => [r.hash, r]));
const txSteps = m.steps.filter((s: any) => s.tx);
const offSteps = m.steps.filter((s: any) => !s.tx);
const reverts = txSteps.filter((s: any) => s.expect === "revert");

const L: string[] = [];
L.push(`# QED — On-chain Evidence (Ethereum Sepolia)`);
L.push("");
L.push(`> Generated from \`${EV}/manifest.json\` and \`${EV}/receipts.json\` by \`npm run evidence:md\`.`);
L.push(`> Re-derive every line from the public chain with \`npm run verify\` (no keys needed).`);
L.push("");
L.push(`| | |`);
L.push(`|---|---|`);
L.push(`| Network | ${m.network.name} (chain id ${m.network.chainId}) |`);
L.push(`| Blocks | ${m.sepolia.firstBlock.toLocaleString("en-US")} → ${m.sepolia.lastBlock.toLocaleString("en-US")} |`);
L.push(`| Transactions | ${R.transactions.length} (${R.transactions.filter((r: any) => r.status === "success").length} succeeded · ${R.transactions.filter((r: any) => r.status === "reverted").length} reverted **by design** — every one an attack or a paused-vault test) |`);
L.push(`| Plus Run 2 (certified clearing) | ${JSON.parse(readFileSync(`${EV}/clearing/receipts.json`, "utf8")).transactions.length} more transactions on a separate contract — [see below](#run-2--certified-clearing-of-an-agent-economy-qedclearing) |`);
L.push(`| Off-chain signed artefacts | ${offSteps.length} (mandate, quote, certificate, vendor release, conversation, red-team) — hashes anchored on-chain |`);
L.push(`| Total gas | ${R.transactions.reduce((a: number, r: any) => a + r.gasUsed, 0).toLocaleString("en-US")} |`);
L.push(`| Language model in the loop | ${(m.llmEnginesUsed ?? []).join(", ")} |`);
L.push("");
L.push(`## Contracts`);
L.push("");
L.push(`| Contract | Address | Deployment tx |`);
L.push(`|---|---|---|`);
const names: Record<string, string> = { token: "TestUSD (tUSD)", verifier: "MinVarianceVerifier", escrow: "ProofEscrow", vault: "QEDVault — the agent's vault", honeypotVault: "QEDVault — HONEYPOT (keys published)", lens: "QEDLens" };
for (const k of ["vault", "escrow", "verifier", "lens", "token", "honeypotVault"]) L.push(`| ${names[k]} | ${addr(m.contracts[k])} | ${tx(m.contracts.txs[k])} |`);
L.push("");
L.push(`## Actors (one key each, one process each)`);
L.push("");
L.push(`| Role | Address |`);
L.push(`|---|---|`);
for (const [k, v] of Object.entries<string>(m.actors)) L.push(`| ${k} | ${addr(v)} |`);
L.push("");
L.push(`## Every step of the scenario`);
L.push("");
L.push(`| Step | What happened | Actor | Result | Transaction | Block | Gas |`);
L.push(`|---|---|---|---|---|---|---|`);
for (const s of m.steps) {
  if (!s.tx) {
    L.push(`| ${s.id} | ${esc(s.title)} | ${esc(s.actor ?? "")} | off-chain, signed | ${s.artifacts?.[0]?.hash ? `\`${s.artifacts[0].hash.slice(0, 12)}…\`` : "—"} | | |`);
    continue;
  }
  const r = rcpt[s.tx.hash];
  const res = s.expect === "revert" ? `**reverted** · \`${s.error?.name}\`` : "success";
  L.push(`| ${s.id} | ${esc(s.title)} | ${esc(s.actor ?? "")} | ${res} | ${tx(s.tx.hash)} | ${r.block} | ${r.gasUsed.toLocaleString("en-US")} |`);
}
L.push("");
L.push(`## Attack transactions (${reverts.length}) — each reverted with exactly the designed error`);
L.push("");
L.push(`| Step | Attack | Defence (custom error) | Layer |`);
L.push(`|---|---|---|---|`);
for (const s of reverts) L.push(`| ${s.id} | ${esc(s.title)} | \`${s.error?.name}\` | ${s.attack?.layer ?? ""} |`);
L.push("");
L.push(`## Set-up transactions (funding, mints, approvals)`);
L.push("");
L.push(`| # | Transaction | What | Block |`);
L.push(`|---|---|---|---|`);
for (const r of R.transactions.filter((r: any) => !r.step)) L.push(`| ${r.i} | ${tx(r.hash)} | ${r.label} | ${r.block} |`);
L.push("");
L.push(`## Final state (read from QEDLens after the last transaction)`);
L.push("");
const f = m.final;
L.push(`| | Balance | Ring-fenced | Free | 24 h blast radius |`);
L.push(`|---|--:|--:|--:|--:|`);
L.push(`| Agent vault | ${usd(f.vault.balance)} | ${usd(f.vault.protected)} | ${usd(f.vault.free)} | ${usd(f.vault.blastRadius24h)} |`);
L.push(`| Honeypot vault | ${usd(f.honeypot.balance)} | ${usd(f.honeypot.protected)} | ${usd(f.honeypot.free)} | ${usd(f.honeypot.blastRadius24h)} |`);
L.push("");
L.push(`Token balances: CloudCo (creditor) ${usd(f.balances.creditor)} · Helix (vendor) ${usd(f.balances.vendor)} · Northwind (client) ${usd(f.balances.client)} · Mallory ${usd(f.balances.mallory)} (all of it minted to her for the test; **0 from any vault or the escrow**).`);
L.push("");
// ---- Run 2: certified clearing ------------------------------------------------------------
const CEV = `${EV}/clearing`;
const C = JSON.parse(readFileSync(`${CEV}/manifest.json`, "utf8"));
const CR = JSON.parse(readFileSync(`${CEV}/receipts.json`, "utf8"));
const crc: Record<string, any> = Object.fromEntries(CR.transactions.map((r: any) => [r.hash, r]));
const cf = C.final;
L.push(`## Run 2 — certified clearing of an agent economy (QEDClearing)`);
L.push("");
L.push(`> \`${CEV}/manifest.json\`, \`receipts.json\`, \`proof.json\`. Separate keys, separate token, separate contract; \`npm run verify\` re-checks it too, including an independent re-check of the netting certificate taken from the executed calldata.`);
L.push("");
L.push(`| | |`);
L.push(`|---|---|`);
L.push(`| Blocks | ${C.sepolia.firstBlock.toLocaleString("en-US")} → ${C.sepolia.lastBlock.toLocaleString("en-US")} |`);
L.push(`| Transactions | ${CR.transactions.length} (${CR.transactions.filter((r: any) => r.status === "success").length} succeeded · ${CR.transactions.filter((r: any) => r.status === "reverted").length} reverted **by design**) |`);
L.push(`| Gross debt between 5 AI businesses | ${usd(cf.gross)} tUSD in 11 obligations; cash held in total ${usd(cf.cash)} tUSD |`);
L.push(`| Naive netting (shortest cycles first) | ${usd(cf.greedyCleared)} — **refused on-chain** as \`NotProvablyMaximal\` |`);
L.push(`| Proven-maximal netting | ${usd(cf.cleared)} cancelled with the LP-duality certificate Σx = Σd·y checked in exact integers |`);
L.push(`| Settled with tokens afterwards | ${usd(cf.settledWithTokens)} tUSD; open obligations at the end: ${cf.openObligations} |`);
L.push("");
L.push(`| Contract | Address |`);
L.push(`|---|---|`);
L.push(`| QEDClearing | ${addr(C.contracts.clearing)} |`);
L.push(`| TestUSD (clearing run) | ${addr(C.contracts.token)} |`);
L.push("");
L.push(`| Role | Address |`);
L.push(`|---|---|`);
for (const [k, v] of Object.entries<string>(C.actors)) L.push(`| ${k} | ${addr(v)} |`);
L.push("");
L.push(`| Step | What happened | Actor | Result | Transaction | Block | Gas |`);
L.push(`|---|---|---|---|---|---|---|`);
for (const s of C.steps) {
  if (!s.tx) {
    L.push(`| ${s.id} | ${esc(s.title)} | ${esc(s.actor ?? "")} | off-chain | — | | |`);
    continue;
  }
  const r = crc[s.tx.hash];
  const res = s.expect === "revert" ? `**reverted** · \`${s.error?.name}\`` : "success";
  L.push(`| ${s.id} | ${esc(s.title)} | ${esc(s.actor ?? "")} | ${res} | ${tx(s.tx.hash)} | ${r.block} | ${r.gasUsed.toLocaleString("en-US")} |`);
}
L.push("");
L.push(`Final token balances equal each agent's net position: ${Object.entries<string>(cf.balances).map(([k, v]) => `${k} ${usd(v)}`).join(" · ")}. Mallory received 0.`);
L.push("");
const setupC = CR.transactions.filter((r: any) => /^setup/.test(r.label ?? ""));
if (setupC.length) L.push(`Set-up transactions of this run (funding, mints): ${setupC.map((r: any) => tx(r.hash)).join(", ")}.`);
L.push("");
L.push(`## How these transactions were produced — full disclosure`);
L.push("");
L.push(m.executionNote);
L.push("");
L.push(`* The relay fetched \`relay/outbox-11155111.json\`, \`relay/outbox-11155111-b2.json\` and \`relay/outbox-11155111-clearing.json\` from a **pinned commit** of this repository and broadcast the bytes unchanged; the transaction hashes in this file are therefore the hashes of those exact bytes.`);
L.push(`* Each public receipt was compared with the replica's receipt: ${m.sepolia.relayComparison}; clearing run: ${C.sepolia.relayComparison}.`);
L.push(`* Block timestamps differ by seconds between replica and Sepolia; no assertion depends on them (windows are 24 h, certificates live 2 h, deadlines are days).`);
L.push(`* Two earlier attempts under different keys failed and were abandoned: the first ran out of gas on deployment under Sepolia's state-creation repricing; in the second, one agent payment was under-provisioned with gas. The vault was slimmed (via-IR; views moved to QEDLens), every transaction now carries an explicit 16.7 M gas limit (only gas used is charged), and the canonical run above was executed under **fresh keys**, so it shares no state with those attempts.`);
L.push(`* Gas used on Sepolia differs from the replica because Sepolia prices state creation and calldata differently; the relay compared status and logs, not gas.`);
L.push("");
L.push(`## Block timestamps`);
L.push("");
const blocks = [...new Set(R.transactions.map((r: any) => r.block))] as number[];
L.push(`First: block ${blocks[0]} at ${iso(R.transactions[0].timestamp)} · last: block ${blocks.at(-1)} at ${iso(R.transactions.at(-1).timestamp)}.`);
L.push("");
writeFileSync("docs/EVIDENCE.md", L.join("\n"));
console.log(`docs/EVIDENCE.md: ${m.steps.length} steps, ${R.transactions.length} transactions`);
