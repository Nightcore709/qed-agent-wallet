/**
 * The release's own recorded evidence, read-only and labelled HISTORICAL on every row: the transactions the QED team
 * mined on Ethereum Sepolia on 19 and 20 October 2026 and the contracts Sourcify verified, read from the vendored
 * release. One function for the vault service and QED's API, so the evidence can be read before any wallet is set up.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { HistoricalEvidence } from "../types.ts";

export function historicalEvidence(vendorRoot: string): HistoricalEvidence {
  const runs: [string, string][] = [
    ["evidence/ethereum-sepolia/manifest.json", "Run 1 · authorised payments, escrow, attacks, honeypot"],
    ["evidence/ethereum-sepolia/clearing/manifest.json", "Run 2 · certified clearing"],
    // the release's own name for the run (EVIDENCE.md): it also deployed and funded the two original 1,000-tUSD bounties (R10-008)
    ["evidence/ethereum-sepolia/private/manifest.json", "Run 3 · zero-knowledge optimality and theorem bounties"],
    ["evidence/ethereum-sepolia/execution/manifest.json", "Run 4 · certified best execution and treasury policy"],
  ];
  const transactions: HistoricalEvidence["transactions"] = [];
  const inManifests = { transactions: 0, reverted: 0 };
  for (const [file, run] of runs) {
    const m = JSON.parse(readFileSync(join(vendorRoot, file), "utf8"));
    inManifests.transactions += Number(m.sepolia?.transactions ?? 0);
    inManifests.reverted += Number(m.sepolia?.reverted ?? 0);
    for (const st of m.steps ?? []) if (st.tx) transactions.push({ label: "HISTORICAL", run, id: st.id, phase: st.phase, title: st.title, hash: st.tx.hash, status: st.tx.status, block: st.tx.blockNumber, gas: st.tx.gasUsed, error: st.error?.name ?? null, expect: st.expect ?? null });
  }
  const contracts: HistoricalEvidence["contracts"] = JSON.parse(readFileSync(join(vendorRoot, "verification/sourcify.json"), "utf8")).contracts.map((c: any) => ({ label: "HISTORICAL", name: c.name, address: c.address, match: c.match }));
  return {
    label: "HISTORICAL",
    network: "Ethereum Sepolia (chain 11155111)",
    explorer: "https://sepolia.etherscan.io",
    note: "Historical: mined on the public Ethereum Sepolia testnet by the QED team on 19 and 20 October 2026, before this application existed. Not created by this session, not re-verified here (the verifier needs a public RPC: owner decision F-063). The rail never contacts that network.",
    transactions, contracts,
    counts: { transactions: transactions.length, reverted: transactions.filter((x) => x.status === "reverted").length, contracts: contracts.length, inManifests },
    excluded: ["evidence/ethereum-sepolia/honeypot.json (published private keys; owner decision F-060)", "site/data.json (the same keys)"],
  };
}
