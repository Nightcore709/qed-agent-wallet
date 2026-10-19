/**
 * Certifying solver for maximal multilateral netting (the off-chain, untrusted side of QEDClearing).
 *
 *   maximise Σₑ xₑ   s.t.   Σ_out(v) x = Σ_in(v) x  ∀v,   0 ≤ xₑ ≤ dₑ          (primal)
 *   minimise Σₑ dₑyₑ  s.t.   π_u − π_v + yₑ ≥ 1  ∀e=(u→v),  yₑ ≥ 0               (dual)
 *
 * The primal is a maximum-gain circulation, i.e. a min-cost circulation with cost −1 per unit of
 * cancelled debt. We solve it exactly with minimum-mean cycle cancelling (Goldberg & Tarjan, 1989),
 * finding each minimum-mean cycle with Karp's algorithm (1978): strongly polynomial, integral.
 *
 * At optimality the residual graph has no negative cycle, so shortest-path distances π exist
 * (Bellman–Ford from a virtual source). With yₑ = max(0, 1 − (π_u − π_v)) the pair (π, y) is dual
 * feasible and complementary-slack, hence Σₑ xₑ = Σₑ dₑyₑ: an exact, integer optimality certificate
 * that QEDClearing.net() checks on-chain in O(edges + members).
 */

export interface Obligation {
  id: bigint;
  debtor: number; // member index
  creditor: number;
  amount: bigint;
}

export interface NettingProof {
  x: bigint[]; // cancelled per obligation, same order as input
  potential: bigint[]; // per member
  y: bigint[]; // per obligation
  cleared: bigint;
  bound: bigint;
}

interface Arc {
  from: number;
  to: number;
  cost: number; // −1 forward (cancel more), +1 backward (cancel less)
  edge: number;
  dir: 1 | -1;
}

function residualArcs(obs: Obligation[], x: bigint[]): Arc[] {
  const arcs: Arc[] = [];
  obs.forEach((o, i) => {
    if (x[i] < o.amount) arcs.push({ from: o.debtor, to: o.creditor, cost: -1, edge: i, dir: 1 });
    if (x[i] > 0n) arcs.push({ from: o.creditor, to: o.debtor, cost: 1, edge: i, dir: -1 });
  });
  return arcs;
}

function residualCap(a: Arc, obs: Obligation[], x: bigint[]): bigint {
  return a.dir === 1 ? obs[a.edge].amount - x[a.edge] : x[a.edge];
}

/** Karp: returns a minimum-mean cycle (as arcs) if its mean is negative, else null. */
function minMeanNegativeCycle(m: number, arcs: Arc[]): Arc[] | null {
  const INF = Number.POSITIVE_INFINITY;
  const D: number[][] = Array.from({ length: m + 1 }, () => new Array(m).fill(INF));
  const P: number[][] = Array.from({ length: m + 1 }, () => new Array(m).fill(-1));
  for (let v = 0; v < m; v++) D[0][v] = 0;
  for (let k = 1; k <= m; k++) {
    arcs.forEach((a, ai) => {
      const cand = D[k - 1][a.from] + a.cost;
      if (cand < D[k][a.to]) {
        D[k][a.to] = cand;
        P[k][a.to] = ai;
      }
    });
  }
  // λ* = min_v max_k (D[m][v] − D[k][v]) / (m − k), compared exactly as fractions
  let best: { v: number; num: number; den: number } | null = null;
  for (let v = 0; v < m; v++) {
    if (D[m][v] === INF) continue;
    let worst: { num: number; den: number } | null = null;
    for (let k = 0; k < m; k++) {
      if (D[k][v] === INF) continue;
      const num = D[m][v] - D[k][v];
      const den = m - k;
      if (!worst || num * worst.den > worst.num * den) worst = { num, den };
    }
    if (worst && (!best || worst.num * best.den < best.num * worst.den)) best = { v, ...worst };
  }
  if (!best || best.num >= 0) return null;

  // Walk back m steps from (m, v*); the walk repeats a node, and the cycle it closes is min-mean.
  const walkNodes: number[] = [best.v];
  const walkArcs: number[] = [];
  let node = best.v;
  for (let k = m; k >= 1; k--) {
    const ai = P[k][node];
    walkArcs.push(ai);
    node = arcs[ai].from;
    walkNodes.push(node);
  }
  // walkNodes[j] is the node at step m−j; find the first repeat
  const seen = new Map<number, number>();
  for (let j = 0; j < walkNodes.length; j++) {
    const nd = walkNodes[j];
    if (seen.has(nd)) {
      const i0 = seen.get(nd)!;
      // arcs walkArcs[i0..j-1] go (backwards in time) from walkNodes[i0] to walkNodes[j] == walkNodes[i0]
      const cyc = walkArcs.slice(i0, j).map((ai) => arcs[ai]).reverse();
      const total = cyc.reduce((s, a) => s + a.cost, 0);
      return total < 0 ? cyc : null;
    }
    seen.set(nd, j);
  }
  return null;
}

/** Bellman–Ford potentials on the residual graph (no negative cycles at optimality). */
function potentials(m: number, arcs: Arc[]): bigint[] {
  const dist = new Array(m).fill(0);
  for (let it = 0; it < m; it++) {
    let changed = false;
    for (const a of arcs) {
      if (dist[a.from] + a.cost < dist[a.to]) {
        dist[a.to] = dist[a.from] + a.cost;
        changed = true;
      }
    }
    if (!changed) break;
  }
  return dist.map((d) => BigInt(d));
}

/** Exact maximal netting with its optimality certificate. */
export function solveNetting(members: number, obs: Obligation[]): NettingProof {
  const x = obs.map(() => 0n);
  for (let guard = 0; guard < 10_000; guard++) {
    const arcs = residualArcs(obs, x);
    const cyc = minMeanNegativeCycle(members, arcs);
    if (!cyc) break;
    const delta = cyc.reduce((mn, a) => {
      const c = residualCap(a, obs, x);
      return c < mn ? c : mn;
    }, residualCap(cyc[0], obs, x));
    for (const a of cyc) x[a.edge] += a.dir === 1 ? delta : -delta;
  }
  const pot = potentials(members, residualArcs(obs, x));
  const y = obs.map((o) => {
    const v = 1n - (pot[o.debtor] - pot[o.creditor]);
    return v > 0n ? v : 0n;
  });
  const cleared = x.reduce((s, v) => s + v, 0n);
  const bound = obs.reduce((s, o, i) => s + o.amount * y[i], 0n);
  return { x, potential: pot, y, cleared, bound };
}

/** A plausible but naive clearing agent: repeatedly cancels the SHORTEST remaining cycle. */
export function greedyNetting(members: number, obs: Obligation[]): bigint[] {
  const x = obs.map(() => 0n);
  const remaining = (i: number) => obs[i].amount - x[i];
  for (let guard = 0; guard < 10_000; guard++) {
    let bestCycle: number[] | null = null;
    for (let s = 0; s < members; s++) {
      // BFS from s back to s over edges with remaining > 0
      const prevEdge = new Map<number, number>();
      const queue: number[] = [s];
      const visited = new Set<number>();
      let found: number[] | null = null;
      while (queue.length && !found) {
        const u = queue.shift()!;
        for (let i = 0; i < obs.length; i++) {
          if (remaining(i) <= 0n || obs[i].debtor !== u) continue;
          const v = obs[i].creditor;
          if (v === s) {
            const path = [i];
            let cur = u;
            while (cur !== s) {
              const e = prevEdge.get(cur)!;
              path.unshift(e);
              cur = obs[e].debtor;
            }
            found = path;
            break;
          }
          if (!visited.has(v)) {
            visited.add(v);
            prevEdge.set(v, i);
            queue.push(v);
          }
        }
      }
      if (found && (!bestCycle || found.length < bestCycle.length)) bestCycle = found;
    }
    if (!bestCycle) break;
    const delta = bestCycle.reduce((mn, i) => (remaining(i) < mn ? remaining(i) : mn), remaining(bestCycle[0]));
    for (const i of bestCycle) x[i] += delta;
  }
  return x;
}

export interface CheckReport {
  ok: boolean;
  cleared: bigint;
  bound: bigint;
  violations: string[];
}

/** Bit-exact re-implementation of QEDClearing.net()'s checks. */
export function checkNetting(members: number, obs: Obligation[], p: { x: bigint[]; potential: bigint[]; y: bigint[] }): CheckReport {
  const v: string[] = [];
  const delta = new Array<bigint>(members).fill(0n);
  let cleared = 0n;
  let bound = 0n;
  obs.forEach((o, i) => {
    if (p.x[i] < 0n) v.push(`Negative(${o.id})`);
    if (p.x[i] > o.amount) v.push(`ExceedsObligation(${o.id})`);
    if (p.y[i] < 0n) v.push(`NegativeDual(${o.id})`);
    if (p.potential[o.debtor] - p.potential[o.creditor] + p.y[i] < 1n) v.push(`DualInfeasible(${o.id})`);
    delta[o.debtor] += p.x[i];
    delta[o.creditor] -= p.x[i];
    cleared += p.x[i];
    bound += o.amount * p.y[i];
  });
  delta.forEach((d, k) => {
    if (d !== 0n) v.push(`NetPositionChanged(${k}, ${d})`);
  });
  if (cleared === 0n) v.push("NothingToNet");
  if (cleared !== bound) v.push(`NotProvablyMaximal(${cleared}, ${bound})`);
  return { ok: v.length === 0, cleared, bound, violations: v };
}

/** Net position (receivable − payable) per member. */
export function netPositions(members: number, obs: Obligation[], x?: bigint[]): bigint[] {
  const pos = new Array<bigint>(members).fill(0n);
  obs.forEach((o, i) => {
    const d = o.amount - (x ? x[i] : 0n);
    pos[o.creditor] += d;
    pos[o.debtor] -= d;
  });
  return pos;
}

/** Order in which remaining (acyclic) obligations can be paid so each payer has first been paid. */
export function settlementOrder(members: number, obs: Obligation[], remaining: bigint[]): number[] {
  const indeg = new Array(members).fill(0);
  const out: number[][] = Array.from({ length: members }, () => []);
  obs.forEach((o, i) => {
    if (remaining[i] <= 0n) return;
    indeg[o.creditor]++;
    out[o.debtor].push(i);
  });
  const ready = indeg.map((d, k) => (d === 0 ? k : -1)).filter((k) => k >= 0);
  const order: number[] = [];
  while (ready.length) {
    const u = ready.shift()!;
    for (const i of out[u]) {
      order.push(i);
      if (--indeg[obs[i].creditor] === 0) ready.push(obs[i].creditor);
    }
  }
  return order;
}
