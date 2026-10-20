/**
 * QED EXECUTE — live run of best execution proved on-chain (Run 4).
 *
 *   npm run local:execute                        (local chain, deterministic dev keys)
 *   KEYS_FILE=.keys.env.execution EXTRA_KEYS=.keys.env.clearing SCRIPT=agent/scripts/execute.ts \
 *     SHADOW_OF=11155111 OUTBOX_NAME=outbox-11155111-execution START_STATE='{…}' npm run local
 *                                                (exact replica of Sepolia → signed outbox → relay)
 *
 * Act 1 — a market. Five constant-product venues across tUSD, tEUR and tETH, seeded by three liquidity
 * providers who drew their tUSD from the public faucet. The owner names the venues; the agent's hot key
 * drives QEDExecution, which is the vault's agent.
 * Act 2 — a conversion. The owner tells the agent, in plain language, to move tUSD into the euro reserve.
 * The language model reads it; the guard and the owner's signature fix the terms; the co-signer re-quotes
 * independently and writes its floor into the order; the agent routes through four venues and two hops
 * and proves, with three prices, that no route could have done better by more than one part per million.
 * Act 3 — a compromised agent. Inside a genuine co-signed order, the agent tries every way to leak value
 * that a slippage limit allows: a single-pair route, a 0.6 bp skim, a "forged" proof, a stranded
 * intermediate token, a tampered order. The chain refuses each one and reports the gap.
 * Act 4 — market risk. Mallory front-runs a signed order; the co-signed floor stops it, and the agent
 * declines to re-submit into a moved market. The proof is about the present; the floor is about the past.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { getAddress, keccak256, parseEther, toHex, type Address, type Hex, type LocalAccount } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { CPMMPoolAbi, CPMMPoolBytecode, QEDExecutionAbi, QEDExecutionBytecode, QEDLensAbi, QEDLensBytecode, QEDVaultAbi, QEDVaultBytecode, TestTokenAbi, TestTokenBytecode, TestUSDAbi, TestUSDBytecode } from "../src/abi/contracts.js";
import { fn, fmtUsd } from "../src/chain.js";
import { chain, EXPLORERS, loadEnvFile, NETWORK_NAMES, rpcConfig } from "../src/config.js";
import { Evidence } from "../src/evidence.js";
import { amountOut as v2Out, simulate, type Hop, type VenueState } from "../src/engine/execution.js";
import { DECIMALS, EXEC_VENUES, raw, TRADE_TUSD, type Sym } from "../src/engine/executionScenario.js";
import { runPolicyPhases } from "./policy-phases.js";
import { decide, hashOrder, hopsForChain, planTrade, pricesForChain, readVenues, type Order, type TradePlan } from "../src/roles/trader.js";
import { PolicyEngine, ownerTradeMessage, type TradeResponse } from "../src/roles/cosigner.js";
import { signMandate, type Mandate } from "../src/protocol/eip712.js";
import { guard, makeBrain, type ChatContext, type PayeeBookEntry } from "../src/brain/index.js";
import { hashRecord } from "../src/protocol/records.js";
import { readFileSync } from "node:fs";

loadEnvFile(process.env.KEYS_FILE ?? ".keys.env.execution");
if (process.env.EXTRA_KEYS) loadEnvFile(process.env.EXTRA_KEYS);
const { chainId, rpcUrl } = rpcConfig();
const LOCAL = chainId === 31337;
const ROLES = ["DEPLOYER", "OWNER", "OPERATOR", "COSIGNER", "GUARDIAN", "LP1", "LP2", "LP3", "MALLORY", "CLOUDCO"] as const;
type R = (typeof ROLES)[number];
for (const r of ROLES) {
  if (process.env[`${r}_PK`]) continue;
  if (!LOCAL) throw new Error(`real key ${r}_PK required for a public network`);
  process.env[`${r}_PK`] = keccak256(toHex(`qed-dev-exec-${r}`));
}
const K = Object.fromEntries(ROLES.map((r) => [r, privateKeyToAccount(process.env[`${r}_PK`] as Hex)])) as Record<R, LocalAccount>;

const network = (NETWORK_NAMES[chainId] ?? `chain-${chainId}`).toLowerCase().replace(/\s+/g, "-");
const OUT = process.env.EVIDENCE_DIR ?? `evidence/${network}/execution`;
mkdirSync(`${OUT}/records`, { recursive: true });
const c = chain();
const ev = new Evidence(OUT);
const rpc = (method: string, params: unknown[]) => (c.pub as any).request({ method, params });
const MAIN = JSON.parse(readFileSync("evidence/ethereum-sepolia/manifest.json", "utf8")).contracts;
const U = (x: number) => raw("tUSD", x);
const fmt = (sym: Sym, x: bigint) => (Number(x) / 10 ** DECIMALS[sym]).toLocaleString("en-US", { maximumFractionDigits: sym === "tETH" ? 6 : 6, minimumFractionDigits: 2 });

/** tUSD and the stateless lens are the main run's contracts on Sepolia; on a local chain they are fresh. */
async function baseContracts(): Promise<{ usd: Address; lens: Address }> {
  if (LOCAL) {
    await rpc("anvil_setBalance", [K.DEPLOYER.address, toHex(parseEther("10"))]);
    await rpc("anvil_setBalance", [K.MALLORY.address, toHex(parseEther("0.01"))]);
    const usd = await c.deploy(K.DEPLOYER, TestUSDAbi as any, TestUSDBytecode as Hex);
    const lens = await c.deploy(K.DEPLOYER, QEDLensAbi as any, QEDLensBytecode as Hex);
    return { usd: getAddress(usd.address), lens: getAddress(lens.address) };
  }
  if (process.env.SHADOW === "1") {
    // Replica of exactly the public state these transactions touch (runtime code from this repository's
    // build, which `npm run verify` checks equal to Sepolia's), plus every signer's nonce and ETH.
    const runtime = async (bytecode: Hex) => (await c.pub.call({ data: bytecode })).data as Hex;
    await rpc("anvil_setCode", [MAIN.token, await runtime(TestUSDBytecode as Hex)]);
    await rpc("anvil_setCode", [MAIN.lens, await runtime(QEDLensBytecode as Hex)]);
    const start = JSON.parse(process.env.START_STATE ?? "{}") as Record<string, { nonce: number; wei: string }>;
    for (const [addr, s] of Object.entries(start)) {
      await rpc("anvil_setNonce", [addr, toHex(s.nonce)]);
      await rpc("anvil_setBalance", [addr, toHex(BigInt(s.wei))]);
    }
  }
  return { usd: getAddress(MAIN.token), lens: getAddress(MAIN.lens) };
}

async function main() {
  console.log(`\nQED Execute live run on ${NETWORK_NAMES[chainId] ?? chainId} via ${rpcUrl}\n`);
  ev.meta = {
    schema: "qed.evidence/v1",
    run: "execution",
    network: { chainId, name: NETWORK_NAMES[chainId] ?? `chain-${chainId}`, explorer: EXPLORERS[chainId] ?? "" },
    startedAt: new Date().toISOString(),
    actors: Object.fromEntries(ROLES.map((r) => [r.toLowerCase(), K[r].address])),
  };
  const { usd, lens } = await baseContracts();

  // ═════════════ 0 · deploy ═════════════
  console.log("PHASE 0 · deploy");
  const D = (id: string, title: string, narrative: string) => (r: any) => ev.tx(id, { phase: "deploy", title, narrative, actor: "Deployer", outcomes: ["O4"] }, r);
  const eur = (await c.deploy(K.DEPLOYER, TestTokenAbi as any, TestTokenBytecode as Hex, ["QED Test Euro", "tEUR", 6]).then(D("D1", "Deploy tEUR, a valueless 6-decimal test euro", "The currency of the euro reserve and of CloudCo's invoices."))) as any;
  const eth = (await c.deploy(K.DEPLOYER, TestTokenAbi as any, TestTokenBytecode as Hex, ["QED Test Ether", "tETH", 18]).then(D("D2", "Deploy tETH, an 18-decimal bridge asset", "A third token, so that the best route can be a two-hop path — the case single-pair routers miss."))) as any;
  const EUR = getAddress(eur.address);
  const ETH = getAddress(eth.address);
  const TOK: Record<Sym, Address> = { tUSD: usd, tEUR: EUR, tETH: ETH };
  const pools: Address[] = [];
  for (const [i, v] of EXEC_VENUES.entries()) {
    const p = (await c.deploy(K.DEPLOYER, CPMMPoolAbi as any, CPMMPoolBytecode as Hex, [TOK[v.a], TOK[v.b], v.feeBps]).then(D(`D${3 + i}`, `Deploy venue ${i}: ${v.label}`, "A Uniswap-V2-interface constant-product pool; the fee is a constructor parameter (V2 is the 30 bps case)."))) as any;
    pools.push(p.address);
  }
  const DAILY = U(100);
  const vault = (await c.deploy(K.DEPLOYER, QEDVaultAbi as any, QEDVaultBytecode as Hex, [usd, K.OWNER.address, K.OPERATOR.address, K.COSIGNER.address, K.GUARDIAN.address, DAILY]).then(D("D8", "Deploy QED's tUSD treasury vault (the unchanged QEDVault)", "Same audited bytecode as runs 1–3: mandate, co-signer, caps, ring-fencing, solvency."))) as any;
  const reserve = (await c.deploy(K.DEPLOYER, QEDVaultAbi as any, QEDVaultBytecode as Hex, [EUR, K.OWNER.address, K.OPERATOR.address, K.COSIGNER.address, K.GUARDIAN.address, 0n]).then(D("D9", "Deploy the euro reserve: a second QEDVault, denominated in tEUR, with a zero agent cap", "A multi-currency treasury is several QED vaults. The agent can fill this one but never spend from it."))) as any;
  const exec = (await c.deploy(K.DEPLOYER, QEDExecutionAbi as any, QEDExecutionBytecode as Hex, [vault.address, K.OPERATOR.address]).then(D("D10", "Deploy QEDExecution for the treasury vault (operator: the AI's hot key)", "Funds reach it only through the vault, in the same transaction; it keeps nothing between transactions."))) as any;
  ev.meta.contracts = { usd, eur: EUR, eth: ETH, pools, vault: vault.address, reserve: reserve.address, execution: exec.address, lens, deployBlock: eur.blockNumber.toString() };

  console.log("\nPHASE 1 · gas, owner configuration");
  for (const [i, [r, eth_]] of ([["OWNER", "0.003"], ["OPERATOR", "0.006"], ["LP1", "0.002"], ["LP2", "0.002"], ["LP3", "0.002"]] as const).entries()) {
    ev.tx(`G${i + 1}`, { phase: "setup", title: `Deployer sends ${eth_} Sepolia ETH for gas to ${r.toLowerCase()}`, narrative: "Gas only. No role but the deployer holds test ETH at the start.", actor: "Deployer", outcomes: ["O4"] }, await c.send(K.DEPLOYER, K[r].address, "0x", { value: parseEther(eth_), gas: 21_000n }));
  }
  ev.tx("O1", { phase: "setup", title: "Owner makes QEDExecution the treasury vault's agent (key rotation, on-chain)", narrative: "The AI's hot key no longer calls the vault directly; it drives the module, which can only reach the vault through executePayment.", actor: "Owner", outcomes: ["O1"] }, await c.send(K.OWNER, vault.address, fn(QEDVaultAbi, "setAgent", [exec.address])));
  ev.tx("O2", { phase: "setup", title: "Owner names the five venues the agent may trade on", narrative: "Every proof must range over all of them, including the ones a route does not use. Changing the set invalidates every outstanding order.", actor: "Owner", outcomes: ["O1", "O3"] }, await c.send(K.OWNER, exec.address, fn(QEDExecutionAbi, "setVenues", [pools, EXEC_VENUES.map((v) => v.feeBps)])));

  // ═════════════ 2 · liquidity ═════════════
  console.log("\nPHASE 2 · three liquidity providers seed the venues from the public faucet");
  for (const [i, lp] of (["LP1", "LP2", "LP3"] as const).entries()) {
    ev.tx(`L${i + 1}`, { phase: "liquidity", title: `${lp} draws 1,000 tUSD from the public faucet`, narrative: "The same faucet any reviewer can use to reproduce this run.", actor: lp, outcomes: ["O4"] }, await c.send(K[lp], usd, fn(TestUSDAbi, "faucet")));
  }
  const usdSource: Record<number, (typeof ROLES)[number]> = { 0: "LP1", 1: "LP2", 2: "LP2", 4: "LP3" };
  let li = 4;
  for (const [i, v] of EXEC_VENUES.entries()) {
    for (const [sym, amt] of [[v.a, v.ra], [v.b, v.rb]] as const) {
      const r = raw(sym, amt);
      if (sym === "tUSD") ev.tx(`L${li++}`, { phase: "liquidity", title: `${usdSource[i]} provides ${fmt(sym, r)} tUSD to venue ${i}`, narrative: v.label, actor: usdSource[i], outcomes: ["O4"] }, await c.send(K[usdSource[i]], usd, fn(TestUSDAbi, "transfer", [pools[i], r])));
      else ev.tx(`L${li++}`, { phase: "liquidity", title: `Deployer mints ${fmt(sym, r)} ${sym} into venue ${i}`, narrative: v.label, actor: "Deployer", outcomes: ["O4"] }, await c.send(K.DEPLOYER, TOK[sym], fn(TestTokenAbi, "mint", [pools[i], r])));
    }
    ev.tx(`L${li++}`, { phase: "liquidity", title: `Venue ${i} syncs its reserves`, narrative: "Uniswap V2 semantics: liquidity counts once sync() records it.", actor: "Deployer", outcomes: ["O4"] }, await c.send(K.DEPLOYER, pools[i], fn(CPMMPoolAbi, "sync")));
  }
  ev.tx(`L${li++}`, { phase: "liquidity", title: "LP3 funds QED's treasury vault with 100 tUSD", narrative: "Stands in for revenue: free balance the agent may convert under its mandate.", actor: "LP3", outcomes: ["O1"] }, await c.send(K.LP3, usd, fn(TestUSDAbi, "transfer", [vault.address, U(100)])));
  ev.tx(`L${li++}`, { phase: "liquidity", title: "LP3 sends Mallory 100 tUSD", narrative: "Capital for the front-running attempt in act 4.", actor: "LP3", outcomes: ["O3"] }, await c.send(K.LP3, usd, fn(TestUSDAbi, "transfer", [K.MALLORY.address, U(100)])));
  const initialVenues = await readVenues(c.pub, exec.address);
  ev.meta.venues = EXEC_VENUES.map((v, i) => ({ ...v, pool: pools[i], token0: initialVenues[i].token0, token1: initialVenues[i].token1, r0: initialVenues[i].r0.toString(), r1: initialVenues[i].r1.toString() }));

  // ═════════════ 3 · the owner's instruction, read by the language model ═════════════
  console.log("\nPHASE 3 · a conversion, end to end");
  const now = BigInt((await c.pub.getBlock()).timestamp);
  const mandate: Mandate = {
    vault: vault.address,
    agent: exec.address,
    payees: [exec.address, reserve.address, K.CLOUDCO.address],
    maxPerPayment: U(25),
    maxPerPeriod: U(100),
    period: 86_400n,
    maxTotal: U(200),
    validFrom: now - 60n,
    validUntil: now + 7n * 86_400n,
    epoch: 0n,
    requireCosign: true,
    purpose: keccak256(toHex("Convert surplus tUSD into the euro operating reserve, with best execution proved on-chain")),
    salt: keccak256(toHex(`qed-execution-mandate-${chainId}`)),
  };
  const ownerSig = await signMandate(K.OWNER, chainId, mandate);
  ev.offchain("A0", { phase: "conversion", title: "Owner signs the trading mandate: payees = execution module, euro reserve, CloudCo; ≤ 25 tUSD per conversion, ≤ 100 a day", narrative: "EIP-712, verified by the vault on every trade. The module checks that each trade's final recipient is one of these payees.", actor: "Owner", actorAddress: K.OWNER.address, outcomes: ["O1"] });

  const cosigner = new PolicyEngine(c, K.COSIGNER, { vault: vault.address, lens, escrow: getAddress(MAIN.escrow), owner: K.OWNER.address, vendorKeys: {}, catalogPrices: {}, denylist: [K.MALLORY.address], deployBlock: eur.blockNumber, recordsDir: `${OUT}/records` });
  const brain = makeBrain();
  const book: PayeeBookEntry[] = [
    { label: "Euro reserve", aliases: ["euro reserve", "eur reserve", "reserve", "euro"], address: reserve.address, approved: true },
    { label: "CloudCo", aliases: ["cloudco", "cloud co"], address: K.CLOUDCO.address, approved: true },
  ];
  const plans: Record<string, unknown> = {};

  async function instruct(id: string, text: string): Promise<bigint> {
    const snap = (await c.pub.readContract({ address: lens, abi: QEDLensAbi, functionName: "snapshot", args: [vault.address] })) as any;
    const ctx: ChatContext = { balance: snap.balance, protectedBalance: snap.protectedBalance, free: snap.freeBalance, blastRadius24h: snap.blastRadius24h, dailyCap: snap.dailyCap, spentInWindow: snap.spentInWindow, paused: snap.paused, payees: book };
    const { result, transcript } = await brain.interpret(text, ctx, "owner");
    const g = guard(text, result, ctx, mandate.maxPerPayment);
    const p = g.proposal;
    if (!p || p.kind !== "pay" || !p.payee || getAddress(p.payee) !== getAddress(reserve.address) || !p.amount) throw new Error(`${id}: the language layer did not produce a conversion to the euro reserve: ${JSON.stringify({ intent: g.intent, proposal: g.proposal, reply: g.reply }, (_, v) => (typeof v === "bigint" ? v.toString() : v))}`);
    const recordPath = `${OUT}/records/${id}-brain.json`;
    writeFileSync(recordPath, JSON.stringify({ input: text, engine: transcript.engine, output: transcript.output, guarded: { intent: g.intent, payee: p.payee, amount: p.amount.toString(), flags: g.flags, needsConfirmation: g.needsConfirmation, reply: g.reply } }, null, 2));
    ev.offchain(id, { phase: "conversion", title: `Owner: “${text}”`, narrative: `${transcript.engine} reads it as: convert ${fmtUsd(p.amount)} tUSD into the euro reserve. The guard resolves the payee from the owner's book (it is a tEUR vault, so paying it means converting) and asks the owner to confirm.`, actor: "Owner → language model → guard", actorAddress: K.OWNER.address, outcomes: ["O1"], artifacts: [{ label: "transcript", path: recordPath }] });
    return p.amount;
  }

  async function review(id: string, amountIn: bigint, instruction: string, nonce: string): Promise<TradeResponse> {
    const instructionSig = await K.OWNER.signMessage({ message: ownerTradeMessage(vault.address, amountIn, usd, EUR, reserve.address, nonce) });
    const r = await cosigner.evaluateTrade({ mandate, ownerSig, module: exec.address, tokenIn: usd, tokenOut: EUR, recipient: reserve.address, amountIn, instruction, nonce, instructionSig, brainEngine: brain.engine });
    if (!r.approved) throw new Error(`${id}: co-signer refused: ${r.reasons.join("; ")}`);
    ev.offchain(id, { phase: "conversion", title: `Owner confirms; the co-signer re-quotes on its own (${fmt("tEUR", r.quote!.amountOut)} tEUR) and signs an order with floor ${fmt("tEUR", r.order!.minOut)} and τ = ${r.order!.tolerancePpm} ppm`, narrative: `${r.checks.length} checks passed, including an independent optimal route, a venue-price manipulation screen and the venue-set hash. Its certificate binds the order hash ${r.certificate!.ref.slice(0, 10)}…; the route and the proof are left to the agent.`, actor: "Owner, then co-signer", actorAddress: K.COSIGNER.address, outcomes: ["O1"], artifacts: [{ label: "co-signer decision record", path: r.recordPath, hash: r.evidenceHash }] });
    return r;
  }

  function recordPlan(id: string, tp: TradePlan) {
    const rec = {
      venues: tp.venues.map((v) => ({ pool: v.pool, r0: v.r0.toString(), r1: v.r1.toString(), feeBps: v.feeBps })),
      route: tp.plan.route.map((h) => ({ venue: h.venue, zeroForOne: h.zeroForOne, amountIn: h.amountIn.toString() })),
      perHop: tp.plan.sim.perHop.map((h) => ({ venue: h.venue, tokenIn: h.tokenIn, tokenOut: h.tokenOut, amountIn: h.amountIn.toString(), amountOut: h.amountOut.toString() })),
      prices: Object.fromEntries([...tp.plan.prices].map(([k, v]) => [k, v.toString()])),
      nu: tp.plan.nu,
      expectedOut: tp.plan.sim.amountOut.toString(),
      bound: tp.onchainBound.toString(),
      gapPpm: tp.plan.gapPpm,
      solverSweeps: tp.plan.iterations,
      alternatives: tp.alternatives.map((a) => ({ ...a, amountOut: a.amountOut.toString() })),
    };
    plans[id] = rec;
    const path = `${OUT}/records/${id}-plan.json`;
    writeFileSync(path, JSON.stringify(rec, null, 2));
    return { path, hash: hashRecord(rec) };
  }

  const tradeData = (r: TradeResponse, route: Hop[], prices: Map<string, bigint>, order: Order = r.order!) =>
    fn(QEDExecutionAbi, "trade", [mandate, ownerSig, r.certificate, r.signature, order, hopsForChain(route), pricesForChain(prices)]);

  // conversion #1
  const instr1 = "Move 20 tUSD of this month's revenue into the euro reserve — CloudCo's euro invoices are due next week.";
  const amt1 = await instruct("A1", instr1);
  const r1 = await review("A2", amt1, instr1, `exec-1-${chainId}`);
  const tp1 = await planTrade(c.pub, exec.address, usd, EUR, amt1);
  const d1 = decide(tp1, r1.order!);
  if (!d1.submit) throw new Error("A3: " + d1.reasons.join("; "));
  const pr1 = recordPlan("A3", tp1);
  const alt = (tp: TradePlan) => tp.alternatives.filter((a) => a.policy !== "certified").map((a) => `${a.policy} −${a.shortfallBps.toFixed(2)} bps`).join(", ");
  ev.offchain("A3", { phase: "conversion", title: `Agent plans: ${tp1.plan.route.length} hops through ${new Set(tp1.plan.route.map((h) => h.venue)).size} venues, expected ${fmt("tEUR", tp1.plan.sim.amountOut)} tEUR; on-chain bound ${fmt("tEUR", tp1.onchainBound)}`, narrative: `Proof: three prices (ν_tUSD ≈ ${tp1.plan.nu[usd.toLowerCase()].toFixed(6)}, ν_tETH ≈ ${(tp1.plan.nu[ETH.toLowerCase()] * 1e12).toFixed(2)}e−12 per raw unit, ν_tEUR = 1), found in ${tp1.plan.iterations} sweeps. Pre-flighted with quoteBound. Alternatives it rejected: ${alt(tp1)}.`, actor: "QED agent", actorAddress: K.OPERATOR.address, outcomes: ["O1"], artifacts: [{ label: "plan with alternatives", path: pr1.path, hash: pr1.hash }] });
  const e1 = await c.send(K.OPERATOR, exec.address, tradeData(r1, tp1.plan.route, tp1.plan.prices));
  const be1 = e1.events.find((e) => e.name === "BestExecution")!.args as any;
  ev.tx("E1", { phase: "conversion", title: `Agent converts 20 tUSD → ${fmt("tEUR", BigInt(be1.amountOut))} tEUR into the euro reserve; the chain checks the proof: bound ${fmt("tEUR", BigInt(be1.bound))}`, narrative: `Realised output within ${(((Number(be1.bound) - Number(be1.amountOut)) / Number(be1.bound)) * 1e6).toFixed(3)} ppm of the best any route could have obtained. Funds moved vault → module → four venues → reserve in one transaction; the module holds nothing afterwards.`, actor: "QED agent (operator key)", outcomes: ["O1", "O2"] }, e1);
  const dueAt = BigInt((await c.pub.getBlock()).timestamp) + 7n * 86_400n;
  ev.tx("R1", { phase: "conversion", title: "Owner ring-fences 15 tEUR in the euro reserve for CloudCo's invoice, due in 7 days", narrative: "The converted money becomes a protected euro liability: from now on it can only reach CloudCo.", actor: "Owner", outcomes: ["O3"] }, await c.send(K.OWNER, reserve.address, fn(QEDVaultAbi, "ringFence", [K.CLOUDCO.address, raw("tEUR", 15), dueAt, keccak256(toHex("CloudCo invoice CC-2026-11 · EUR 15.00 · GPU hours"))])));

  // ═════════════ 4 · a compromised agent inside a genuine order ═════════════
  console.log("\nPHASE 4 · the agent's key is compromised: every leak a slippage limit would allow");
  const instr2 = "Top up the euro reserve with another 20 tUSD.";
  const amt2 = await instruct("A4", instr2);
  const r2 = await review("A5", amt2, instr2, `exec-2-${chainId}`);
  const tp2 = await planTrade(c.pub, exec.address, usd, EUR, amt2);
  const pr2 = recordPlan("A6", tp2);
  ev.offchain("A6", { phase: "attack", title: `Honest plan for order 2: ${fmt("tEUR", tp2.plan.sim.amountOut)} tEUR, bound ${fmt("tEUR", tp2.onchainBound)}; floor ${fmt("tEUR", r2.order!.minOut)}`, narrative: `Everything between ${fmt("tEUR", r2.order!.minOut)} and ${fmt("tEUR", tp2.onchainBound)} tEUR is what a slippage-only wallet would let a compromised agent leak.`, actor: "QED agent", actorAddress: K.OPERATOR.address, outcomes: ["O3"], artifacts: [{ label: "plan", path: pr2.path, hash: pr2.hash }] });
  const v2 = tp2.venues;
  const attackSim = (route: Hop[]) => simulate(v2, route, usd, EUR, amt2);
  const direct = tp2.alternatives.find((a) => a.policy === "direct-optimal")!;
  const { optimalDirectOnly, bestSingleVenue, solve } = await import("../src/engine/execution.js");
  const directRoute = optimalDirectOnly(v2, usd, EUR, amt2)!.route;
  const nudged = tp2.plan.route.map((h) => ({ ...h }));
  {
    const src = nudged.filter((h) => h.amountIn > 0n && (h.zeroForOne ? v2[h.venue].token0 : v2[h.venue].token1) === usd).sort((a, b) => (a.amountIn > b.amountIn ? -1 : 1));
    const shift = src[0].amountIn / 20n;
    src[0].amountIn -= shift;
    src[1].amountIn += shift;
  }
  const directProof = solve(v2.filter((v) => v.token0 !== ETH && v.token1 !== ETH), usd, EUR, amt2).prices;
  const forged = new Map(tp2.plan.prices);
  forged.set(usd.toLowerCase(), directProof.get(usd.toLowerCase())!);
  forged.set(ETH.toLowerCase(), (tp2.plan.prices.get(ETH.toLowerCase())! * 9n) / 10n);
  const stranded = tp2.plan.route.filter((h) => (h.zeroForOne ? v2[h.venue].token0 : v2[h.venue].token1) !== ETH);
  const single = bestSingleVenue(v2, usd, EUR, amt2)!;
  const bps = (x: bigint) => ((Number(tp2.plan.sim.amountOut - x) / Number(tp2.plan.sim.amountOut)) * 1e4).toFixed(2);
  const atk = (id: string, title: string, a: { class: string; threat: string; defence: string; layer: string }, who: LocalAccount, data: Hex) =>
    c.sendExpectingRevert(who, exec.address, data, 2_000_000n).then((r) => ev.tx(id, { phase: "attack", title, narrative: `${a.threat} → ${a.defence}`, actor: who === K.MALLORY ? "Mallory" : "Compromised agent (operator key)", outcomes: ["O3"], attack: a, expect: "revert" }, r));
  const sDirect = attackSim(directRoute);
  await atk("EA1", `Route over the direct pools only, optimally split: ${fmt("tEUR", sDirect.amountOut)} tEUR (−${bps(sDirect.amountOut)} bps, above the 1% floor)`, { class: "suboptimal_execution", threat: "Leak value with the route a single-pair aggregator would pick, inside the slippage limit", defence: "The realised output is below the dual bound: NotBestExecution", layer: "QEDExecution" }, K.OPERATOR, tradeData(r2, directRoute, tp2.plan.prices));
  const sNudged = attackSim(nudged);
  await atk("EA2", `Skim: the optimal route with 5% of one leg moved (−${bps(sNudged.amountOut)} bps)`, { class: "suboptimal_execution", threat: "Leak a fraction of a basis point per trade, invisible to any slippage check", defence: "1 ppm tolerance: NotBestExecution", layer: "QEDExecution" }, K.OPERATOR, tradeData(r2, nudged, tp2.plan.prices));
  await atk("EA3", "A “forged proof”: prices chosen to make the single-pair route look optimal", { class: "proof_forgery", threat: "Supply prices that lower the bound", defence: "Weak duality: every price vector is a valid upper bound, so forging only loosens it: NotBestExecution", layer: "QEDExecution" }, K.OPERATOR, tradeData(r2, directRoute, forged));
  await atk("EA4", "Strand the bridge token: buy tETH and never sell it", { class: "value_diversion", threat: "Leave value inside the module for later extraction", defence: "Nothing may be left behind: Leftover", layer: "QEDExecution" }, K.OPERATOR, tradeData(r2, stranded, tp2.plan.prices));
  const sSingle = attackSim(single);
  await atk("EA5", `Everything through one pool: ${fmt("tEUR", sSingle.amountOut)} tEUR (−${bps(sSingle.amountOut)} bps)`, { class: "suboptimal_execution", threat: "The naive router", defence: "Below the co-signed floor: InsufficientOutput", layer: "QEDExecution (co-signed order)" }, K.OPERATOR, tradeData(r2, single, tp2.plan.prices));
  const tampered: Order = { ...r2.order!, recipient: K.MALLORY.address };
  await atk("EA6", "Redirect the order's output to Mallory", { class: "order_tampering", threat: "Change who receives the euros", defence: "The co-signer's certificate commits to the order hash: OrderMismatch", layer: "QEDExecution + co-signer" }, K.OPERATOR, tradeData(r2, tp2.plan.route, tp2.plan.prices, tampered));
  await atk("EA7", "Mallory calls the module directly with the genuine order", { class: "unauthorized_caller", threat: "Use a leaked order without the agent key", defence: "Only the operator key may trade: NotOperator", layer: "QEDExecution" }, K.MALLORY, tradeData(r2, tp2.plan.route, tp2.plan.prices));
  const e2 = await c.send(K.OPERATOR, exec.address, tradeData(r2, tp2.plan.route, tp2.plan.prices));
  const be2 = e2.events.find((e) => e.name === "BestExecution")!.args as any;
  ev.tx("E2", { phase: "attack", title: `Same order, honest route: ${fmt("tEUR", BigInt(be2.amountOut))} tEUR, bound ${fmt("tEUR", BigInt(be2.bound))}: accepted`, narrative: "The seven refusals cost the attacker gas and moved nothing; the honest trade still goes through with the same certificate.", actor: "QED agent (operator key)", outcomes: ["O1", "O3"] }, e2);
  void direct;

  // ═════════════ 5 · market risk ═════════════
  console.log("\nPHASE 5 · Mallory front-runs a signed order");
  const instr3 = "And put another 20 tUSD into the euro reserve.";
  const amt3 = await instruct("A7", instr3);
  const r3 = await review("A8", amt3, instr3, `exec-3-${chainId}`);
  const tp3 = await planTrade(c.pub, exec.address, usd, EUR, amt3);
  const pr3 = recordPlan("A9", tp3);
  ev.offchain("A9", { phase: "market", title: `Agent signs its plan for order 3: ${fmt("tEUR", tp3.plan.sim.amountOut)} tEUR expected, floor ${fmt("tEUR", r3.order!.minOut)}`, narrative: "The signed transaction is now public in the mempool.", actor: "QED agent", actorAddress: K.OPERATOR.address, outcomes: ["O3"], artifacts: [{ label: "plan", path: pr3.path, hash: pr3.hash }] });
  const frontRun: [number, bigint][] = [];
  for (const [vi, amt] of [[0, U(30)], [1, U(10)]] as const) {
    const v = (await readVenues(c.pub, exec.address))[vi];
    const z = v.token0 === usd;
    const out = v2Out(amt, z ? v.r0 : v.r1, z ? v.r1 : v.r0, v.feeBps);
    frontRun.push([vi, out]);
    ev.tx(`M${vi * 2 + 1}`, { phase: "market", title: `Mallory front-runs: sends ${fmtUsd(amt)} tUSD to venue ${vi}`, narrative: "Buying tEUR ahead of the agent pushes its price up on the venues the route uses.", actor: "Mallory", outcomes: ["O3"] }, await c.send(K.MALLORY, usd, fn(TestUSDAbi, "transfer", [pools[vi], amt])));
    ev.tx(`M${vi * 2 + 2}`, { phase: "market", title: `…and takes ${fmt("tEUR", out)} tEUR out of venue ${vi}`, narrative: "A plain Uniswap-V2-style swap.", actor: "Mallory", outcomes: ["O3"] }, await c.send(K.MALLORY, pools[vi], fn(CPMMPoolAbi, "swap", [z ? 0n : out, z ? out : 0n, K.MALLORY.address, "0x"])));
  }
  const stale = attackSim3(tp3, await readVenues(c.pub, exec.address));
  await c.sendExpectingRevert(K.OPERATOR, exec.address, tradeData(r3, tp3.plan.route, tp3.plan.prices), 2_000_000n).then((r) =>
    ev.tx("EA8", { phase: "market", title: `The agent's signed trade lands after the front-run: it would now yield ${fmt("tEUR", stale)} tEUR`, narrative: "Market risk, not agent discretion: the bound is computed on the moved state, so it is the co-signed floor that refuses the trade.", actor: "QED agent (operator key)", outcomes: ["O3"], attack: { class: "front_running", threat: "Sandwich a signed order", defence: "Co-signed floor: InsufficientOutput", layer: "QEDExecution (co-signed order)" }, expect: "revert" }, r),
  );
  const tp3b = await planTrade(c.pub, exec.address, usd, EUR, amt3).catch((e: Error) => e);
  writeFileSync(`${OUT}/records/A10-venues.json`, JSON.stringify((await readVenues(c.pub, exec.address)).map((v) => ({ ...v, r0: v.r0.toString(), r1: v.r1.toString() })), null, 2));
  if (!(tp3b instanceof Error)) recordPlan("A10", tp3b);
  const d3 = tp3b instanceof Error ? { submit: false, reasons: [`no certifiable route on the moved market (${tp3b.message})`] } : decide(tp3b, r3.order!);
  ev.offchain("A10", { phase: "market", title: d3.submit ? "Agent re-plans and resubmits" : `Agent re-plans on the moved market${tp3b instanceof Error ? "" : ` (${fmt("tEUR", tp3b.plan.sim.amountOut)} tEUR at best)`} and declines to trade`, narrative: d3.submit ? "The new plan clears the floor." : `${d3.reasons.join("; ")}. It would need a fresh owner instruction and co-signer quote; it does not ask for one into a manipulated market.`, actor: "QED agent", actorAddress: K.OPERATOR.address, outcomes: ["O1", "O3"] });

  let policyOutcome = "";
  // ═════════════ 6 · the agent decides (local chain only: on Sepolia this is Run 4c, execute-policy.ts) ═════════════
  if (LOCAL) {
    console.log("\nPHASE 6 · the agent decides under a standing policy");
    const { policy, ticks } = await runPolicyPhases({ c, ev, K, k: { usd, eur: EUR, pools, vault: vault.address, reserve: reserve.address, execution: exec.address }, cosigner, mandate, ownerSig, out: OUT, chainId, unwind: frontRun });
    ev.meta.policyRun = { policy: { ...policy, targetFree: policy.targetFree.toString(), maxTranche: policy.maxTranche.toString(), minTranche: policy.minTranche.toString(), validUntil: policy.validUntil.toString() }, ticks };
    policyOutcome = ticks.at(-1)?.action === "none" ? "; the standing policy met its target" : `; the standing policy ended in "${ticks.at(-1)?.action}"`;
    // with the default policy the loop must reach its target (CI checks this); custom POLICY_* settings may end in "wait"
    if (!process.env.POLICY_TARGET && !process.env.POLICY_IMPACT_BPS && ticks.at(-1)?.action !== "none") throw new Error(`policy loop did not reach its target: ${JSON.stringify(ticks.at(-1))}`);
  }

  // ═════════════ final state ═════════════
  const bal = async (t: Address, a: Address) => (await c.pub.readContract({ address: t, abi: TestUSDAbi, functionName: "balanceOf", args: [a] })) as bigint;
  ev.meta.plans = plans;
  ev.meta.orders = Object.fromEntries([["1", r1], ["2", r2], ["3", r3]].map(([k, r]: any) => [k, { order: { ...r.order, minOut: r.order.minOut.toString() }, orderHash: hashOrder(r.order), intentId: r.certificate.intentId, evidenceHash: r.evidenceHash, quote: r.quote.amountOut.toString() }]));
  ev.meta.final = {
    vaultUsd: (await bal(usd, vault.address)).toString(),
    reserveEur: (await bal(EUR, reserve.address)).toString(),
    moduleHoldings: { usd: (await bal(usd, exec.address)).toString(), eur: (await bal(EUR, exec.address)).toString(), eth: (await bal(ETH, exec.address)).toString() },
    malloryEurFromModule: "0",
    trades: [{ id: "E1", amountIn: be1.amountIn.toString(), amountOut: be1.amountOut.toString(), bound: be1.bound.toString() }, { id: "E2", amountIn: be2.amountIn.toString(), amountOut: be2.amountOut.toString(), bound: be2.bound.toString() }],
    brainEngine: brain.engine,
  };
  ev.meta.finishedAt = new Date().toISOString();
  ev.flush();
  console.log(`\nDONE. Reserve holds ${fmt("tEUR", await bal(EUR, reserve.address))} tEUR; 8 attacks refused; module holds nothing${LOCAL ? policyOutcome : ""}.`);

  function attackSim3(tp: TradePlan, now: VenueState[]) {
    return simulate(now, tp.plan.route, usd, EUR, amt3).amountOut;
  }
}

main().catch((e) => {
  console.error("\nFATAL", e);
  process.exitCode = 1;
});
