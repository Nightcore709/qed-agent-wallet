import { test } from "node:test";
import assert from "node:assert/strict";
import { checkNetting, greedyNetting, netPositions, settlementOrder, solveNetting, type Obligation } from "../src/engine/netting.js";
import { clearingObligations } from "../src/engine/clearingScenario.js";

let seed = 20261020;
const rnd = (n: number) => {
  seed = (seed * 1103515245 + 12345) % 2 ** 31;
  return seed % n;
};

function randomEconomy(maxAmount: number): { m: number; obs: Obligation[] } {
  const m = 3 + rnd(4);
  const e = 3 + rnd(6);
  const obs: Obligation[] = [];
  for (let i = 0; i < e; i++) {
    const d = rnd(m);
    let c = rnd(m - 1);
    if (c >= d) c += 1;
    obs.push({ id: BigInt(i + 1), debtor: d, creditor: c, amount: BigInt(1 + rnd(maxAmount)) });
  }
  return { m, obs };
}

/** Exhaustive oracle: try every integer cancellation vector (tiny amounts only). */
function bruteForceMax(m: number, obs: Obligation[]): bigint {
  let best = 0n;
  const x = obs.map(() => 0n);
  const rec = (i: number) => {
    if (i === obs.length) {
      const pos = netPositions(m, obs, x);
      const base = netPositions(m, obs);
      if (pos.every((p, k) => p === base[k])) {
        const s = x.reduce((a, b) => a + b, 0n);
        if (s > best) best = s;
      }
      return;
    }
    for (let v = 0n; v <= obs[i].amount; v++) {
      x[i] = v;
      rec(i + 1);
    }
    x[i] = 0n;
  };
  rec(0);
  return best;
}

test("demo economy: 169 of 200 cancelled, certificate exact, greedy only 162", () => {
  const obs = clearingObligations();
  const p = solveNetting(5, obs);
  const r = checkNetting(5, obs, p);
  assert.ok(r.ok, r.violations.join(","));
  assert.equal(p.cleared, 169_000_000n);
  assert.equal(p.bound, p.cleared);
  assert.equal(greedyNetting(5, obs).reduce((a, b) => a + b, 0n), 162_000_000n);
});

test("solver equals an exhaustive brute-force oracle on 150 tiny economies", () => {
  for (let t = 0; t < 150; t++) {
    const { m, obs } = randomEconomy(3);
    const p = solveNetting(m, obs);
    const truth = bruteForceMax(m, obs);
    assert.equal(p.cleared, truth, `economy ${t}`);
    if (p.cleared > 0n) assert.ok(checkNetting(m, obs, p).ok, `economy ${t} certificate`);
    assert.ok(greedyNetting(m, obs).reduce((a, b) => a + b, 0n) <= truth);
  }
});

test("netting never changes a net position and leaves an acyclic remainder that settles with net debits only", () => {
  for (let t = 0; t < 200; t++) {
    const { m, obs } = randomEconomy(60);
    const p = solveNetting(m, obs);
    assert.deepEqual(netPositions(m, obs, p.x), netPositions(m, obs));
    const remaining = obs.map((o, i) => o.amount - p.x[i]);
    const order = settlementOrder(m, obs, remaining);
    assert.equal(order.length, remaining.filter((r) => r > 0n).length, "remaining debts form a DAG");
    const cash = netPositions(m, obs).map((v) => (v < 0n ? -v : 0n));
    for (const i of order) {
      cash[obs[i].debtor] -= remaining[i];
      assert.ok(cash[obs[i].debtor] >= 0n, "payer always has the cash");
      cash[obs[i].creditor] += remaining[i];
    }
  }
});
