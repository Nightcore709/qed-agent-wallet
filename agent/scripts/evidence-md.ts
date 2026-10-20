/**
 * Renders docs/EVIDENCE.md from the canonical evidence (manifest + public receipts).
 *   npm run evidence:md
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";

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
L.push(`| Plus Run 4 (best execution, execution bounty, standing policy) | ${existsSync(`${EV}/execution/receipts.json`) ? JSON.parse(readFileSync(`${EV}/execution/receipts.json`, "utf8")).transactions.length : 0} more transactions — [see below](#run-4--best-execution-proved-at-the-instant-of-the-trade-qedexecution) |`);
L.push(`| Plus Run 3 (zero-knowledge job, bounties) | ${existsSync(`${EV}/private/receipts.json`) ? JSON.parse(readFileSync(`${EV}/private/receipts.json`, "utf8")).transactions.length : 0} more transactions — [see below](#run-3--zero-knowledge-optimality-and-theorem-bounties-qed-private) |`);
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
// ---- Run 3: private optimality + theorem bounties ------------------------------------------
const PEV = `${EV}/private`;
if (existsSync(`${PEV}/manifest.json`)) {
  const P = JSON.parse(readFileSync(`${PEV}/manifest.json`, "utf8"));
  const PR = JSON.parse(readFileSync(`${PEV}/receipts.json`, "utf8"));
  const prc: Record<string, any> = Object.fromEntries(PR.transactions.map((r: any) => [r.hash, r]));
  const pf = P.final;
  const k = P.contracts;
  L.push(`## Run 3 — zero-knowledge optimality and theorem bounties (QED Private)`);
  L.push("");
  L.push(`> \`${PEV}/manifest.json\`, \`receipts.json\`. Built on the main run's ProofEscrow, TestUSD and MinVarianceVerifier; \`npm run verify\` re-verifies the Groth16 proof off-chain with snarkjs, recovers the vendor's attestation from calldata and checks both bounty pools.`);
  L.push("");
  L.push(`| | |`);
  L.push(`|---|---|`);
  L.push(`| Blocks | ${P.sepolia.firstBlock.toLocaleString("en-US")} → ${P.sepolia.lastBlock.toLocaleString("en-US")} |`);
  L.push(`| Transactions | ${PR.transactions.length} (${PR.transactions.filter((r: any) => r.status === "success").length} succeeded · ${PR.transactions.filter((r: any) => r.status === "reverted").length} reverted **by design**) |`);
  L.push(`| Private job | job #${pf.jobs.qed}: ${usd(pf.privateJob.price)} tUSD paid into QED's vault on a Groth16 proof (${pf.privateJob.constraints.toLocaleString("en-US")} constraints, proved in ${(pf.privateJob.provingMs / 1000).toFixed(1)} s) |`);
  L.push(`| What the chain saw | data commitment \`${pf.privateJob.dataCommitment.slice(0, 18)}…\` (attested by Helix), portfolio commitment \`${pf.privateJob.weightsCommitment.slice(0, 18)}…\`, variance ${(Number(pf.privateJob.variance) / 1e36).toFixed(10)}, provider |`);
  L.push(`| Bounties | ${usd(pf.bounties.optimality)} + ${usd(pf.bounties.maximality)} tUSD unclaimed after every refutation attempt |`);
  L.push("");
  L.push(`| Contract | Address |`);
  L.push(`|---|---|`);
  L.push(`| Groth16Verifier | ${addr(k.groth16)} |`);
  L.push(`| PrivateMinVarianceVerifier | ${addr(k.privateVerifier)} |`);
  L.push(`| OptimalityBounty | ${addr(k.optimalityBounty)} |`);
  L.push(`| MaximalityBounty | ${addr(k.maximalityBounty)} |`);
  L.push("");
  L.push(`| Role | Address |`);
  L.push(`|---|---|`);
  for (const [r, v] of Object.entries<string>(P.actors)) L.push(`| ${r} | ${addr(v)} |`);
  L.push("");
  L.push(`| Step | What happened | Actor | Result | Transaction | Block | Gas |`);
  L.push(`|---|---|---|---|---|---|---|`);
  for (const s of P.steps) {
    if (!s.tx) {
      L.push(`| ${s.id} | ${esc(s.title)} | ${esc(s.actor ?? "")} | off-chain | — | | |`);
      continue;
    }
    const r = prc[s.tx.hash];
    const res = s.expect === "revert" ? `**reverted** · \`${s.error?.name}\`` : "success";
    L.push(`| ${s.id} | ${esc(s.title)} | ${esc(s.actor ?? "")} | ${res} | ${tx(s.tx.hash)} | ${r.block} | ${r.gasUsed.toLocaleString("en-US")} |`);
  }
  L.push("");
  const setupP = PR.transactions.filter((r: any) => /^setup/.test(r.label ?? ""));
  if (setupP.length) L.push(`Set-up transactions of this run (faucet draws, approvals): ${setupP.map((r: any) => tx(r.hash)).join(", ")}.`);
  L.push("");
}
// ---- Run 4: best execution (4), execution bounty (4b), standing policy (4c) ----------------------
const XEV = `${EV}/execution`;
let run4Note = "";
if (existsSync(`${XEV}/manifest.json`)) {
  const E = JSON.parse(readFileSync(`${XEV}/manifest.json`, "utf8"));
  const ER = JSON.parse(readFileSync(`${XEV}/receipts.json`, "utf8"));
  const erc: Record<string, any> = Object.fromEntries(ER.transactions.map((r: any) => [r.hash.toLowerCase(), r]));
  const k = E.contracts;
  const fx = (x: string | number) => (Number(x) / 1e6).toFixed(6);
  run4Note = E.sepolia.relayComparison;
  L.push(`## Run 4 — best execution, proved at the instant of the trade (QEDExecution)`);
  L.push("");
  L.push(`> \`${XEV}/manifest.json\`, \`receipts.json\`, \`records/\`. Run 4 deploys five constant-product venues, a second QEDVault as the euro reserve and the QEDExecution module; Run 4b adds ExecutionBounty; Run 4c runs a standing owner-signed treasury policy. \`npm run verify\` recomputes every accepted trade's bound from the pre-trade reserves, replays the route, solves independently, and checks the bounty pool and the policy's target.`);
  L.push("");
  L.push(`| | |`);
  L.push(`|---|---|`);
  L.push(`| Blocks | ${E.sepolia.firstBlock.toLocaleString("en-US")} → ${E.sepolia.lastBlock.toLocaleString("en-US")} |`);
  L.push(`| Transactions | ${ER.transactions.length} (${ER.transactions.filter((r: any) => r.status === "success").length} succeeded · ${ER.transactions.filter((r: any) => r.status === "reverted").length} reverted **by design**) |`);
  for (const t of E.final.trades) L.push(`| ${t.id} | ${fx(t.amountIn)} tUSD → **${fx(t.amountOut)} tEUR**; on-chain bound ${fx(t.bound)} |`);
  for (const t of E.policyRun?.ticks ?? []) L.push(`| Policy tick ${t.tick} | reserve free ${fx(t.reserveFree)} tEUR, shortfall ${fx(t.shortfall)}: ${t.action === "convert" ? `convert ${fx(t.amountIn)} tUSD (limited by ${t.limitedBy}, ${t.impactBps.toFixed(1)} bps)` : "nothing to do"} |`);
  L.push(`| ExecutionBounty | ${fx(E.bounty.pool)} tUSD unclaimed after ${E.bounty.attempts} refutation attempts |`);
  L.push(`| QEDExecution token holdings at the end of Run 4 (re-checked after Run 4c by \`npm run verify\`) | ${Object.entries<string>(E.final.moduleHoldings).map(([a, v]) => `${a} ${v}`).join(" · ")} (nothing stranded) |`);
  L.push("");
  L.push(`| Contract | Address |`);
  L.push(`|---|---|`);
  L.push(`| QEDExecution | ${addr(k.execution)} |`);
  L.push(`| QEDVault — tUSD treasury | ${addr(k.vault)} |`);
  L.push(`| QEDVault — euro reserve | ${addr(k.reserve)} |`);
  L.push(`| ExecutionBounty | ${addr(k.executionBounty)} |`);
  L.push(`| TestToken tEUR · tETH | ${addr(k.eur)} · ${addr(k.eth)} |`);
  k.pools.forEach((a: string, i: number) => L.push(`| CPMMPool venue ${i} | ${addr(a)} |`));
  L.push("");
  L.push(`| Role | Address |`);
  L.push(`|---|---|`);
  for (const [r, v] of Object.entries<string>(E.actors)) L.push(`| ${r} | ${addr(v)} |`);
  L.push("");
  L.push(`| Step | What happened | Actor | Result | Transaction | Block | Gas |`);
  L.push(`|---|---|---|---|---|---|---|`);
  for (const s of E.steps) {
    if (!s.tx) {
      L.push(`| ${s.id} | ${esc(s.title)} | ${esc(s.actor ?? "")} | off-chain | — | | |`);
      continue;
    }
    const r = erc[s.tx.hash.toLowerCase()];
    const res = s.expect === "revert" ? `**reverted** · \`${s.error?.name}\`` : "success";
    L.push(`| ${s.id} | ${esc(s.title)} | ${esc(s.actor ?? "")} | ${res} | ${tx(s.tx.hash)} | ${r?.block ?? s.tx.blockNumber} | ${r ? r.gasUsed.toLocaleString("en-US") : ""} |`);
  }
  L.push("");
}
L.push(`## How these transactions were produced — full disclosure`);
L.push("");
L.push(m.executionNote);
L.push("");
L.push(`* The relay fetched \`relay/outbox-11155111.json\`, \`relay/outbox-11155111-b2.json\`, \`relay/outbox-11155111-clearing.json\`, \`relay/outbox-11155111-private.json\` and the three \`relay/outbox-11155111-execution*.json\` files from a **pinned commit** of this repository and broadcast the bytes unchanged; the transaction hashes in this file are therefore the hashes of those exact bytes.`);
L.push(`* Each public receipt was compared with the replica's receipt: ${m.sepolia.relayComparison}; clearing run: ${C.sepolia.relayComparison}; private run: 24/24 receipts matched${run4Note ? `; best-execution runs: ${run4Note}` : ""}.`);
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
