/**
 * The demo agent economy for QED Clearing: five AI businesses that owe each other 200 tUSD in
 * overlapping cycles while holding only 28 tUSD of cash between them. Every number here is
 * illustrative; the invoices are synthetic.
 */
import type { Obligation } from "./netting.js";

export const CLEARING_MEMBERS = ["Northwind", "QED", "CloudCo", "Helix", "Atlas"] as const;

export const CLEARING_OBLIGATIONS: { debtor: number; creditor: number; tusd: number; memo: string }[] = [
  { debtor: 0, creditor: 1, tusd: 40, memo: "portfolio subscription" },
  { debtor: 1, creditor: 2, tusd: 30, memo: "GPU compute" },
  { debtor: 2, creditor: 3, tusd: 25, memo: "data licence" },
  { debtor: 3, creditor: 0, tusd: 20, memo: "advisory fees" },
  { debtor: 1, creditor: 3, tusd: 15, memo: "risk model" },
  { debtor: 3, creditor: 1, tusd: 15, memo: "model validation" },
  { debtor: 2, creditor: 0, tusd: 12, memo: "volume rebate" },
  { debtor: 0, creditor: 2, tusd: 10, memo: "hosting" },
  { debtor: 4, creditor: 1, tusd: 18, memo: "backtests" },
  { debtor: 3, creditor: 4, tusd: 9, memo: "data cleaning" },
  { debtor: 2, creditor: 4, tusd: 6, memo: "labelling" },
];

export const USD = 1_000_000n;

export function clearingObligations(firstId = 1n): Obligation[] {
  return CLEARING_OBLIGATIONS.map((o, i) => ({ id: firstId + BigInt(i), debtor: o.debtor, creditor: o.creditor, amount: BigInt(o.tusd) * USD }));
}

/** All simple directed cycles (as obligation indices) — used to fuzz conservation-preserving moves. */
export function simpleCycles(members: number, obs: Obligation[]): number[][] {
  const out: number[][] = [];
  const seen = new Set<string>();
  const dfs = (start: number, u: number, path: number[], visited: Set<number>) => {
    obs.forEach((o, i) => {
      if (o.debtor !== u) return;
      if (o.creditor === start) {
        const cyc = [...path, i];
        const key = [...cyc].sort((a, b) => a - b).join(",");
        if (!seen.has(key)) {
          seen.add(key);
          out.push(cyc);
        }
      } else if (o.creditor > start && !visited.has(o.creditor)) {
        visited.add(o.creditor);
        dfs(start, o.creditor, [...path, i], visited);
        visited.delete(o.creditor);
      }
    });
  };
  for (let s = 0; s < members; s++) dfs(s, s, [], new Set([s]));
  return out;
}
