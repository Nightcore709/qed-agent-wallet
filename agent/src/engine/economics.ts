/**
 * Deterministic economic engine. The LLM may describe an opportunity; THIS decides whether it is worth
 * doing. Revenue that has not settled never counts as spendable capital (only free, on-chain balance
 * does), and every decision keeps a reserve buffer above the vault's ring-fenced liabilities.
 */
export interface TreasuryView {
  balance: bigint;
  protectedBalance: bigint;
  free: bigint;
  dailyCap: bigint;
  spentInWindow: bigint;
}

export interface CostLine {
  label: string;
  amount: bigint;
}

export interface Check {
  id: string;
  name: string;
  pass: boolean;
  detail: string;
}

export interface JobEvaluation {
  accept: boolean;
  price: bigint;
  cost: bigint;
  margin: bigint;
  marginBps: number;
  postTradeFree: bigint;
  checks: Check[];
  reason: string;
}

export const POLICY = {
  reserveBuffer: 5_000_000n, //   keep ≥ 5 tUSD free after any discretionary spend
  markupBps: 15_000, //           price = cost × 2.5, rounded up to a whole tUSD
  minMarginBps: 3_000, //         reject jobs with < 30% margin
  minPrice: 10_000_000n,
  maxDeliveryHours: 72,
};

const fmt = (x: bigint) => (Number(x) / 1e6).toFixed(2);

export function priceFor(cost: bigint): bigint {
  const raw = (cost * BigInt(10_000 + POLICY.markupBps)) / 10_000n;
  const whole = ((raw + 999_999n) / 1_000_000n) * 1_000_000n;
  return whole > POLICY.minPrice ? whole : POLICY.minPrice;
}

export function evaluateJob(t: TreasuryView, costs: CostLine[], clientBudget: bigint, deliveryHours: number): JobEvaluation {
  const cost = costs.reduce((a, c) => a + c.amount, 0n);
  const price = priceFor(cost);
  const margin = price - cost;
  const marginBps = price > 0n ? Number((margin * 10_000n) / price) : 0;
  const postTradeFree = t.free - cost;
  const windowLeft = t.dailyCap > t.spentInWindow ? t.dailyCap - t.spentInWindow : 0n;
  const checks: Check[] = [
    { id: "E1", name: "Client budget covers price", pass: clientBudget >= price, detail: `price ${fmt(price)} ≤ budget ${fmt(clientBudget)}` },
    { id: "E2", name: "Positive contribution margin", pass: marginBps >= POLICY.minMarginBps, detail: `margin ${fmt(margin)} (${(marginBps / 100).toFixed(1)}%) ≥ ${POLICY.minMarginBps / 100}%` },
    { id: "E3", name: "Upfront cost fundable from FREE balance", pass: cost <= t.free, detail: `cost ${fmt(cost)} ≤ free ${fmt(t.free)}` },
    { id: "E4", name: "Reserve buffer preserved after spend", pass: postTradeFree >= POLICY.reserveBuffer, detail: `free after ${fmt(postTradeFree)} ≥ buffer ${fmt(POLICY.reserveBuffer)}` },
    { id: "E5", name: "Within today's spending window", pass: cost <= windowLeft, detail: `cost ${fmt(cost)} ≤ window remaining ${fmt(windowLeft)}` },
    { id: "E6", name: "Deliverable in time", pass: deliveryHours <= POLICY.maxDeliveryHours, detail: `${deliveryHours}h ≤ ${POLICY.maxDeliveryHours}h` },
    { id: "E7", name: "Unsettled revenue NOT counted as capital", pass: true, detail: `the ${fmt(price)} fee is excluded from spendable funds until the escrow settles` },
  ];
  const failed = checks.filter((c) => !c.pass);
  return {
    accept: failed.length === 0,
    price,
    cost,
    margin,
    marginBps,
    postTradeFree,
    checks,
    reason: failed.length === 0 ? `Accept: ${fmt(margin)} tUSD margin, ring-fence untouched, ${fmt(postTradeFree)} free after costs.` : `Decline: ${failed.map((f) => f.name).join("; ")}.`,
  };
}
