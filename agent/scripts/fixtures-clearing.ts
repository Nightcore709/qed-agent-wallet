/**
 * Generates Solidity fixtures for QEDClearing from the TypeScript certifying solver.
 *   npm run fixtures:clearing  →  contracts/test/fixtures/clearing.json
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { encodeAbiParameters, type Hex } from "viem";
import { checkNetting, greedyNetting, netPositions, settlementOrder, solveNetting, type Obligation } from "../src/engine/netting.js";
import { clearingObligations, simpleCycles } from "../src/engine/clearingScenario.js";

const M = 5;
const obs = clearingObligations();
const opt = solveNetting(M, obs);
if (!checkNetting(M, obs, opt).ok) throw new Error("demo certificate invalid");
const greedy = greedyNetting(M, obs);
const pos = netPositions(M, obs);
const remaining = obs.map((o, i) => o.amount - opt.x[i]);
const order = settlementOrder(M, obs, remaining);
const cycles = simpleCycles(M, obs);

// Random economies: 3–7 members, 3–16 obligations, 1–60 tUSD each.
let seed = 0x51ed;
const rnd = (n: number) => {
  seed = (seed * 1103515245 + 12345) % 2 ** 31;
  return seed % n;
};
const cases: Hex[] = [];
let strictlyBetter = 0;
for (let c = 0; c < 60; c++) {
  const m = 3 + rnd(5);
  const e = 3 + rnd(14);
  const o: Obligation[] = [];
  for (let i = 0; i < e; i++) {
    const d = rnd(m);
    let cr = rnd(m - 1);
    if (cr >= d) cr += 1;
    o.push({ id: BigInt(i + 1), debtor: d, creditor: cr, amount: BigInt(1 + rnd(60)) * 1_000_000n });
  }
  const p = solveNetting(m, o);
  { const r = checkNetting(m, o, p); if (!r.ok && !(r.violations.length === 1 && r.violations[0] === "NothingToNet")) throw new Error(`case ${c}: invalid certificate ${r.violations}`); if (p.cleared === 0n) { c--; continue; } }
  const g = greedyNetting(m, o);
  const gc = g.reduce((s, v) => s + v, 0n);
  if (gc > p.cleared) throw new Error(`case ${c}: greedy beat the optimum?`);
  if (gc < p.cleared) strictlyBetter++;
  cases.push(
    encodeAbiParameters(
      [
        { type: "uint256" },
        { type: "uint256[]" },
        { type: "uint256[]" },
        { type: "uint128[]" },
        { type: "uint128[]" },
        { type: "int256[]" },
        { type: "uint128[]" },
        { type: "uint256" },
        { type: "uint128[]" },
        { type: "uint256" },
      ],
      [BigInt(m), o.map((x) => BigInt(x.debtor)), o.map((x) => BigInt(x.creditor)), o.map((x) => x.amount), p.x, p.potential, p.y, p.cleared, g, gc],
    ),
  );
}

const s = (a: bigint[]) => a.map(String);
const fixture = {
  members: M,
  debtors: obs.map((o) => o.debtor),
  creditors: obs.map((o) => o.creditor),
  amounts: s(obs.map((o) => o.amount)),
  optimal: { x: s(opt.x), potential: s(opt.potential), y: s(opt.y), cleared: opt.cleared.toString() },
  greedy: { x: s(greedy), cleared: greedy.reduce((a, b) => a + b, 0n).toString() },
  netPositions: s(pos),
  settlementOrder: order,
  cycles,
  randomCases: cases,
};
mkdirSync("contracts/test/fixtures", { recursive: true });
writeFileSync("contracts/test/fixtures/clearing.json", JSON.stringify(fixture, null, 1));
console.log(`wrote contracts/test/fixtures/clearing.json — demo cleared ${opt.cleared / 1_000_000n}/200 tUSD, greedy ${fixture.greedy.cleared}, ${cycles.length} simple cycles, ${cases.length} random economies (${strictlyBetter} where greedy is strictly worse)`);
