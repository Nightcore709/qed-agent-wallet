/**
 * QED PRIVATE — live run of zero-knowledge fiduciary proofs and theorem bounties.
 *
 *   KEYS_FILE=.keys.env.clearing SCRIPT=agent/scripts/private.ts SHADOW_OF=11155111 \
 *     DEPLOYER_START_WEI=… DEPLOYER_START_NONCE=12 OUTBOX_NAME=outbox-11155111-private npm run local
 *   (or `npm run local:private`: a local chain with deterministic dev keys)
 *
 * Act 1 — private optimality. Helix attests a covariance model by commitment only. A wealth-manager
 * agent (Northwind) commissions the optimal portfolio on it through the SAME ProofEscrow that settled
 * job #1, naming a verifier that did not exist when the escrow was deployed. QED proves optimality in
 * zero knowledge; the escrow pays QED's vault for a proof about data and a portfolio it never sees.
 * Mallory replays QED's proof, understates the variance, and fabricates a certified track record on
 * self-attested data: all refused on-chain.
 *
 * Act 2 — theorems with money on them. Two contracts each hold 1 000 tUSD and pay it automatically to
 * anyone who refutes, on-chain, the optimality theorem behind job #1 or the maximality theorem behind
 * the clearing run. Mallory tries; the chain answers with the size of the gap she could not close.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { decodeAbiParameters, decodeFunctionData, keccak256, parseEther, parseTransaction, toHex, type Address, type Hex, type LocalAccount } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import {
  Groth16VerifierAbi,
  Groth16VerifierBytecode,
  MaximalityBountyAbi,
  MaximalityBountyBytecode,
  MinVarianceVerifierAbi,
  MinVarianceVerifierBytecode,
  OptimalityBountyAbi,
  OptimalityBountyBytecode,
  PrivateMinVarianceVerifierAbi,
  PrivateMinVarianceVerifierBytecode,
  ProofEscrowAbi,
  ProofEscrowBytecode,
  TestUSDAbi,
  TestUSDBytecode,
} from "../src/abi/contracts.js";
import { fn, fmtUsd } from "../src/chain.js";
import { chain, EXPLORERS, loadEnvFile, NETWORK_NAMES, rpcConfig } from "../src/config.js";
import { Evidence } from "../src/evidence.js";
import {
  attestationDigest,
  certifyFixed,
  checkWitness,
  commitData,
  commitWeights,
  covToFixed,
  encodePrivateSolution,
  encodePrivateSpec,
  prove,
  randomSalt,
  shutdownProver,
  ONE,
} from "../src/engine/privateMinvar.js";
import { covarianceFrom } from "../src/engine/riskModel.js";
import { PRIVATE_ASSETS, PRIVATE_UNIVERSE, privateCovariance } from "../src/engine/privateScenario.js";
import { CLEARING_OBLIGATIONS, USD } from "../src/engine/clearingScenario.js";

loadEnvFile(process.env.KEYS_FILE ?? ".keys.env.clearing");
const { chainId, rpcUrl } = rpcConfig();
const ROLES = ["DEPLOYER", "NORTHWIND", "QEDM", "CLOUDCO", "HELIX", "ATLAS", "MALLORY"] as const;
const LOCAL = chainId === 31337;
if (!process.env.DEPLOYER_PK) {
  if (!LOCAL) throw new Error("real keys required for a public network");
  for (const r of ROLES) process.env[`${r}_PK`] = keccak256(toHex(`qed-dev-clearing-${r}`));
  console.log("no keys found → deterministic DEV keys (local chain only)");
}
const acct = (r: (typeof ROLES)[number]): LocalAccount => privateKeyToAccount(process.env[`${r}_PK`] as Hex);
const deployer = acct("DEPLOYER");
const client = acct("NORTHWIND"); // a wealth-manager agent buying a private portfolio
const qed = acct("QEDM"); // the same QED agent key that proved the maximal netting
const helix = acct("HELIX"); // the data vendor: signs a commitment, never publishes the model
const sponsor = acct("ATLAS"); // funds the second bounty
const mallory = acct("MALLORY");

const network = (NETWORK_NAMES[chainId] ?? `chain-${chainId}`).toLowerCase().replace(/\s+/g, "-");
const OUT = process.env.EVIDENCE_DIR ?? `evidence/${network}/private`;
mkdirSync(OUT, { recursive: true });
const c = chain();
const ev = new Evidence(OUT);
const MAIN = JSON.parse(readFileSync("evidence/ethereum-sepolia/manifest.json", "utf8"));
const CLEAR = JSON.parse(readFileSync("evidence/ethereum-sepolia/clearing/proof.json", "utf8"));
const rpc = (method: string, params: unknown[]) => (c.pub as any).request({ method, params });

/** Main-run contracts the private run builds on (on a local chain they are deployed fresh). */
async function mainContracts(): Promise<{ token: Address; escrow: Address; verifier: Address; vault: Address }> {
  if (LOCAL) {
    await rpc("anvil_setBalance", [deployer.address, "0x16345785D8A0000"]);
    const t = await c.deploy(deployer, TestUSDAbi as any, TestUSDBytecode as Hex);
    const e = await c.deploy(deployer, ProofEscrowAbi as any, ProofEscrowBytecode as Hex);
    const v = await c.deploy(deployer, MinVarianceVerifierAbi as any, MinVarianceVerifierBytecode as Hex);
    for (const a of [client, qed, helix, sponsor, mallory]) await c.send(deployer, a.address, "0x", { value: parseEther("0.01") });
    return { token: t.address, escrow: e.address, verifier: v.address, vault: "0x441f71f12a1f8a3b7d432851d4d4244fc33e8ca6" };
  }
  const k = MAIN.contracts;
  if (process.env.SHADOW === "1") {
    // Replica of the public state these transactions touch: the main run's token, escrow and verifier
    // (runtime code of this repository's build — verified equal to Sepolia's by `npm run verify`),
    // the escrow's job counter (2 jobs so far) and every role's nonce and ETH from the clearing run.
    const runtime = async (bytecode: Hex) => (await c.pub.call({ data: bytecode })).data as Hex;
    await rpc("anvil_setCode", [k.token, await runtime(TestUSDBytecode as Hex)]);
    await rpc("anvil_setCode", [k.escrow, await runtime(ProofEscrowBytecode as Hex)]);
    await rpc("anvil_setCode", [k.verifier, await runtime(MinVarianceVerifierBytecode as Hex)]);
    await rpc("anvil_setStorageAt", [k.escrow, toHex(2, { size: 32 }), toHex(1, { size: 32 })]); // ReentrancyGuard: NOT_ENTERED
    await rpc("anvil_setStorageAt", [k.escrow, toHex(3, { size: 32 }), toHex(2, { size: 32 })]); // jobCount = 2
    const outbox = JSON.parse(readFileSync("relay/outbox-11155111-clearing.json", "utf8"));
    const receipts = JSON.parse(readFileSync("relay/receipts-11155111-clearing.json", "utf8"));
    const byHash = new Map<string, any>(receipts.transactions.map((r: any) => [r.hash.toLowerCase(), r]));
    for (const a of [client, qed, helix, sponsor, mallory]) {
      const mine = outbox.filter((t: any) => t.from.toLowerCase() === a.address.toLowerCase());
      const spent = mine.reduce((s: bigint, t: any) => s + BigInt(byHash.get(t.hash.toLowerCase()).gasUsed) * BigInt(byHash.get(t.hash.toLowerCase()).effectiveGasPrice), 0n);
      await rpc("anvil_setNonce", [a.address, toHex(mine.length)]);
      await rpc("anvil_setBalance", [a.address, toHex(parseEther("0.003") - spent)]);
    }
  }
  return { token: k.token, escrow: k.escrow, verifier: k.verifier, vault: k.vault };
}

async function main() {
  console.log(`\nQED Private live run on ${NETWORK_NAMES[chainId] ?? chainId} via ${rpcUrl}\n`);
  ev.meta = {
    schema: "qed.evidence/v1",
    run: "private",
    network: { chainId, name: NETWORK_NAMES[chainId] ?? `chain-${chainId}`, explorer: EXPLORERS[chainId] ?? "" },
    startedAt: new Date().toISOString(),
    actors: { deployer: deployer.address, client: client.address, qed: qed.address, helix: helix.address, sponsor: sponsor.address, mallory: mallory.address },
  };
  const { token, escrow, verifier, vault } = await mainContracts();

  // ═════════════ 0 · deploy the zero-knowledge verifier and the two bounties ═════════════
  console.log("PHASE 0 · deploy");
  const g = await c.deploy(deployer, Groth16VerifierAbi as any, Groth16VerifierBytecode as Hex);
  ev.tx("K3", { phase: "deploy", title: "Deploy the Groth16 verifier generated from circuits/private_minvar.circom", narrative: "12,569 constraints: the KKT certificate, the convexity witness, exact budget, range checks and Poseidon commitments.", actor: "Deployer", outcomes: ["O4"] }, g);
  const pv = await c.deploy(deployer, PrivateMinVarianceVerifierAbi as any, PrivateMinVarianceVerifierBytecode as Hex, [g.address, helix.address]);
  ev.tx("K4", { phase: "deploy", title: "Deploy PrivateMinVarianceVerifier (registered data vendor: Helix)", narrative: "An IProofVerifier the existing ProofEscrow can use without any change: vendor attestation, provider binding, Groth16 check.", actor: "Deployer", outcomes: ["O2", "O4"] }, pv);
  const ob = await c.deploy(deployer, OptimalityBountyAbi as any, OptimalityBountyBytecode as Hex, [verifier, token]);
  ev.tx("K5", { phase: "deploy", title: "Deploy OptimalityBounty on the verifier that settled job #1", narrative: "Pays its whole balance to anyone who refutes Theorem 4.4 on-chain: an accepted certificate plus a strictly better portfolio.", actor: "Deployer", outcomes: ["O3", "O4"] }, ob);
  const mb = await c.deploy(deployer, MaximalityBountyAbi as any, MaximalityBountyBytecode as Hex, [token]);
  ev.tx("K6", { phase: "deploy", title: "Deploy MaximalityBounty on the clearing house's acceptance rule", narrative: "Pays its whole balance to anyone who exhibits a netting larger than one QEDClearing would accept as proven maximal.", actor: "Deployer", outcomes: ["O3", "O4"] }, mb);
  ev.meta.contracts = { groth16: g.address, privateVerifier: pv.address, optimalityBounty: ob.address, maximalityBounty: mb.address, token, escrow, verifier, vault, deployBlock: g.blockNumber.toString() };

  const POOL = 1_000n * USD;
  await c.send(deployer, token, fn(TestUSDAbi, "faucet"));
  ev.tx("B1", { phase: "bounty", title: "QED funds the optimality bounty: 1,000 tUSD", narrative: "Money on a theorem. If our verifier ever accepts a portfolio that a better one beats by more than the proven bound, anyone can take it.", actor: "Deployer", outcomes: ["O4"] }, await c.send(deployer, token, fn(TestUSDAbi, "transfer", [ob.address, POOL])));
  await c.send(sponsor, token, fn(TestUSDAbi, "faucet"));
  ev.tx("B2", { phase: "bounty", title: "Atlas funds the maximality bounty: 1,000 tUSD", narrative: "Money on the clearing house: a netting larger than a proven-maximal one would collect it.", actor: "Atlas", outcomes: ["O4"] }, await c.send(sponsor, token, fn(TestUSDAbi, "transfer", [mb.address, POOL])));

  // ═════════════ 1 · Helix commits to its model; QED and Mallory quote ═════════════
  console.log("\nPHASE 1 · data attestation and quotes");
  const cov = privateCovariance();
  const saltData = randomSalt();
  const dataCommitment = await commitData({ cov, salt: saltData });
  const vendorSig = await helix.signMessage({ message: { raw: attestationDigest(BigInt(chainId), dataCommitment, PRIVATE_UNIVERSE) } });
  ev.offchain("V0", { phase: "private", title: "Helix attests its Private Markets model by commitment only", narrative: `Poseidon commitment ${toHex(dataCommitment).slice(0, 18)}… signed by Helix's key. The 21 covariance entries never leave Helix and QED.`, actor: "Helix (data vendor)", actorAddress: helix.address, outcomes: ["O2"] });

  const now = BigInt(Math.floor(Date.now() / 1000));
  const quote = (provider: LocalAccount, payee: Address, price: bigint, spec: Hex, id: string) => ({
    provider: provider.address,
    payee,
    client: client.address,
    token,
    price,
    verifier: pv.address,
    specHash: keccak256(spec),
    deliverBy: now + 7n * 86400n,
    validUntil: now + 2n * 86400n,
    quoteId: keccak256(toHex(id)),
  });
  const sign = async (who: LocalAccount, q: any) => who.signTypedData({
    domain: { name: "ProofEscrow", version: "1", chainId, verifyingContract: escrow },
    types: { Quote: [{ name: "provider", type: "address" }, { name: "payee", type: "address" }, { name: "client", type: "address" }, { name: "token", type: "address" }, { name: "price", type: "uint256" }, { name: "verifier", type: "address" }, { name: "specHash", type: "bytes32" }, { name: "deliverBy", type: "uint64" }, { name: "validUntil", type: "uint64" }, { name: "quoteId", type: "bytes32" }] },
    primaryType: "Quote",
    message: q,
  });
  const specQ = encodePrivateSpec({ dataCommitment, universe: PRIVATE_UNIVERSE, provider: qed.address, vendorSig });
  const specM = encodePrivateSpec({ dataCommitment, universe: PRIVATE_UNIVERSE, provider: mallory.address, vendorSig });
  const qQ = quote(qed, vault, 12n * USD, specQ, "qed-private-1");
  const qM = quote(mallory, mallory.address, 8n * USD, specM, "mallory-private-1");
  const [sQ, sM] = [await sign(qed, qQ), await sign(mallory, qM)];
  ev.offchain("Q1", { phase: "private", title: "QED quotes 12 tUSD for the provably optimal private portfolio; Mallory undercuts at 8", narrative: "Each quote names the escrow verifier and a spec that binds the proof to its own provider. The client accepts only specs that name the quoting provider.", actor: "QED agent / Mallory", actorAddress: qed.address, outcomes: ["O2"] });

  await c.send(client, token, fn(TestUSDAbi, "faucet"));
  await c.send(client, token, fn(TestUSDAbi, "approve", [escrow, 2n ** 255n]));
  const jobs = (o: any) => BigInt(o.events.find((e: any) => e.name === "JobOpened").args.jobId);
  const o1 = await c.send(client, escrow, fn(ProofEscrowAbi, "open", [qQ, sQ]));
  ev.tx("Z1", { phase: "private", title: `Northwind funds job #${jobs(o1)} in the same ProofEscrow: 12 tUSD, verifier = zero-knowledge`, narrative: "The escrow deployed for job #1 now settles a private job against a verifier written later. No upgrade, no admin: the verifier is part of the signed terms.", actor: "Northwind (client)", outcomes: ["O2"] }, o1);
  const o2 = await c.send(client, escrow, fn(ProofEscrowAbi, "open", [qM, sM]));
  ev.tx("Z2", { phase: "private", title: `Northwind also funds Mallory's cheaper job #${jobs(o2)}: 8 tUSD`, narrative: "Shopping around is safe when payment needs a proof: the client risks nothing on a provider that cannot deliver one.", actor: "Northwind (client)", outcomes: ["O2"] }, o2);
  const [jobQ, jobM] = [jobs(o1), jobs(o2)];

  // ═════════════ 2 · QED proves optimality in zero knowledge and is paid ═════════════
  console.log("\nPHASE 2 · QED proves optimality without revealing the data or the portfolio");
  const cert = certifyFixed(cov);
  const rep = checkWitness({ cov, ...cert });
  if (!rep.ok) throw new Error("witness: " + rep.violations.join("; "));
  const saltW = randomSalt();
  const proof = await prove({ cov, saltData, ...cert, saltW, dataCommitment, provider: BigInt(qed.address) });
  const weightsCommitment = await commitWeights(cert.w, saltW);
  const solQ = encodePrivateSolution(proof.calldata, proof.signals.weightsCommitment, proof.signals.variance);
  ev.offchain("P1", { phase: "private", title: `QED proves the portfolio optimal in zero knowledge (${(proof.provingMs / 1000).toFixed(1)} s on one CPU)`, narrative: `Groth16 over 12,569 constraints: KKT stationarity, dual feasibility, complementary slackness (gap ${rep.gap}), convexity witness, exact budget. Public: two commitments, variance ${(Number(proof.signals.variance) / 1e36).toFixed(8)} and QED's address. Private: everything else.`, actor: "QED agent", actorAddress: qed.address, outcomes: ["O2"] });
  const d1 = await c.send(qed, escrow, fn(ProofEscrowAbi, "deliver", [jobQ, specQ, solQ]));
  ev.tx("Z3", { phase: "private", title: "QED delivers the zero-knowledge proof: the escrow verifies it and pays 12 tUSD into QED's vault", narrative: "The chain checked that the portfolio is optimal for Helix's attested model, and never saw the model or the portfolio. Northwind receives the weights and salt off-chain and checks them against the commitment.", actor: "QED agent", outcomes: ["O2"] }, d1);

  // ═════════════ 3 · Mallory ═════════════
  console.log("\nPHASE 3 · Mallory tries to get paid without the work");
  const atk = (id: string, title: string, a: { class: string; threat: string; defence: string; layer: string }, who: LocalAccount, to: Address, data: Hex) =>
    c.sendExpectingRevert(who, to, data, 2_000_000n).then((r) => ev.tx(id, { phase: "private-attack", title, narrative: `${a.threat} → ${a.defence}`, actor: "Mallory", outcomes: ["O3"], attack: a, expect: "revert" }, r));
  await atk("ZA1", "Mallory copies QED's proof from the public calldata into her own job", { class: "proof_theft", threat: "Replay someone else's valid proof", defence: "The proof is bound to QED's address as a public input: ProofRejected", layer: "PrivateMinVarianceVerifier" }, mallory, escrow, fn(ProofEscrowAbi, "deliver", [jobM, specM, solQ]));
  await atk("ZA2", "Mallory claims a lower variance than any portfolio can achieve", { class: "fake_work", threat: "Overstate the quality of the work", defence: "The variance is a public signal of the proof: ProofRejected", layer: "PrivateMinVarianceVerifier" }, mallory, escrow, fn(ProofEscrowAbi, "deliver", [jobM, specM, encodePrivateSolution(proof.calldata, proof.signals.weightsCommitment, proof.signals.variance - 1n)]));
  // a self-dealt job on a self-attested data set: a fabricated "certified" track record
  const fakeCov = covToFixed(covarianceFrom([0.01, 0.01, 0.01, 0.01, 0.01, 0.01], PRIVATE_IDENTITY));
  const fakeCommit = await commitData({ cov: fakeCov, salt: 7n });
  const fakeSig = await mallory.signMessage({ message: { raw: attestationDigest(BigInt(chainId), fakeCommit, PRIVATE_UNIVERSE) } });
  const specF = encodePrivateSpec({ dataCommitment: fakeCommit, universe: PRIVATE_UNIVERSE, provider: mallory.address, vendorSig: fakeSig });
  const fakeCert = certifyFixed(fakeCov);
  const fakeProof = await prove({ cov: fakeCov, saltData: 7n, ...fakeCert, saltW: 8n, dataCommitment: fakeCommit, provider: BigInt(mallory.address) });
  const qF = { ...quote(mallory, mallory.address, 1n * USD, specF, "mallory-self-dealt"), client: mallory.address };
  await c.send(mallory, token, fn(TestUSDAbi, "faucet"));
  await c.send(mallory, token, fn(TestUSDAbi, "approve", [escrow, 2n ** 255n]));
  const o3 = await c.send(mallory, escrow, fn(ProofEscrowAbi, "open", [qF, await sign(mallory, qF)]));
  ev.tx("ZM", { phase: "private-attack", title: `Mallory opens a self-dealt job #${jobs(o3)} on a data set she attested herself`, narrative: "A valid proof on made-up data would mint a fake certified track record.", actor: "Mallory", outcomes: ["O3"] }, o3);
  await atk("ZA3", "Mallory delivers a genuine proof about self-attested data", { class: "data_poisoning", threat: "Prove optimality on fabricated data", defence: "Only the registered vendor's attestation counts: UntrustedDataAttestation", layer: "PrivateMinVarianceVerifier" }, mallory, escrow, fn(ProofEscrowAbi, "deliver", [jobs(o3), specF, encodePrivateSolution(fakeProof.calldata, fakeProof.signals.weightsCommitment, fakeProof.signals.variance)]));

  // ═════════════ 4 · theorems with money on them ═════════════
  console.log("\nPHASE 4 · Mallory goes after the bounties");
  const deliverTx = mainDeliverCalldata();
  const n = 6;
  const W = 10n ** 18n;
  const eq = Array.from({ length: n }, () => W / BigInt(n));
  eq[0] += W - eq.reduce((a, b) => a + b, 0n);
  await atk("BA1", "Mallory claims the 1,000 tUSD bounty with the equal-weight portfolio against QED's job #1 certificate", { class: "theorem_refutation", threat: "Show the paid portfolio was not optimal", defence: "The bounty recomputes both variances and the bound: TheoremHolds", layer: "OptimalityBounty" }, mallory, ob.address, fn(OptimalityBountyAbi, "claim", [deliverTx.spec, deliverTx.solution, eq]));
  const near = [...deliverTx.w];
  const step = W / 1000n;
  near[deliverTx.top] -= step;
  near[deliverTx.second] += step;
  await atk("BA2", "…and with QED's own optimum shifted by 0.1%", { class: "theorem_refutation", threat: "Find any portfolio that beats the certified one", defence: "Every feasible portfolio is no better than the bound allows: TheoremHolds", layer: "OptimalityBounty" }, mallory, ob.address, fn(OptimalityBountyAbi, "claim", [deliverTx.spec, deliverTx.solution, near]));
  await atk("BA3", "…and with the forged 1/N certificate the chain refused in job #2 (X17)", { class: "theorem_refutation", threat: "Use a certificate the verifier never accepted", defence: "The bounty first re-runs the deployed verifier: DualityGapTooLarge", layer: "OptimalityBounty" }, mallory, ob.address, fn(OptimalityBountyAbi, "claim", [deliverTx.spec, mainDeliver("X17").solution, deliverTx.w]));

  const econ = { members: 5n, debtor: CLEARING_OBLIGATIONS.map((o) => BigInt(o.debtor)), creditor: CLEARING_OBLIGATIONS.map((o) => BigInt(o.creditor)), d: CLEARING_OBLIGATIONS.map((o) => BigInt(o.tusd) * USD) };
  const certified = { x: CLEAR.obligations.map((o: any) => BigInt(o.cancelled)), potential: CLEAR.potential.map(BigInt), y: CLEAR.obligations.map((o: any) => BigInt(o.y)) };
  const greedy = CLEAR.obligations.map((o: any) => BigInt(o.greedyCancelled));
  await atk("BM1", "Mallory claims the clearing bounty with the naive netting (162 tUSD)", { class: "theorem_refutation", threat: "Exhibit a larger netting than the proven-maximal 169", defence: "Weak LP duality: TheoremHolds(169, 162)", layer: "MaximalityBounty" }, mallory, mb.address, fn(MaximalityBountyAbi, "claim", [econ, certified, greedy]));
  const bigger = [...certified.x];
  bigger[0] += USD; // cancel 1 tUSD more of Northwind's debt to QED: 170 tUSD in total
  await atk("BM2", "…and with a 170 tUSD netting that cancels 1 tUSD more of Northwind's debt to QED", { class: "theorem_refutation", threat: "Beat the bound by moving value", defence: "A netting must leave every net position unchanged: NetPositionChanged", layer: "MaximalityBounty" }, mallory, mb.address, fn(MaximalityBountyAbi, "claim", [econ, certified, bigger]));

  const bal = async (a: Address) => (await c.pub.readContract({ address: token, abi: TestUSDAbi, functionName: "balanceOf", args: [a] })) as bigint;
  const [obLeft, mbLeft] = [await bal(ob.address), await bal(mb.address)];
  ev.meta.final = {
    jobs: { qed: jobQ.toString(), mallory: jobM.toString(), selfDealt: jobs(o3).toString() },
    privateJob: { price: qQ.price.toString(), payee: vault, dataCommitment: toHex(dataCommitment, { size: 32 }), weightsCommitment: toHex(weightsCommitment, { size: 32 }), variance: proof.signals.variance.toString(), provingMs: Math.round(proof.provingMs), constraints: 12569, support: cert.support.map((i) => PRIVATE_ASSETS[i]) },
    bounties: { optimality: obLeft.toString(), maximality: mbLeft.toString() },
    malloryFromEscrowOrBounties: "0",
  };
  // what the client receives off-chain (kept out of the public evidence: only its hash is published)
  writeFileSync(`${OUT}/client-delivery.private.json`, JSON.stringify({ assets: PRIVATE_ASSETS, weights: cert.w.map((w) => (Number(w) / Number(ONE)).toFixed(12)), saltW: toHex(saltW), weightsCommitment: toHex(weightsCommitment, { size: 32 }) }, null, 2));
  ev.meta.finishedAt = new Date().toISOString();
  ev.flush();
  console.log(`\nDONE. Job #${jobQ} settled on a zero-knowledge proof; ${fmtUsd(obLeft)} + ${fmtUsd(mbLeft)} tUSD still unclaimed in the bounties.`);
  await shutdownProver();
}

const PRIVATE_IDENTITY = Array.from({ length: 6 }, (_, i) => Array.from({ length: 6 }, (_, j) => (i === j ? 1 : 0)));

/** The calldata of a main-run ProofEscrow.deliver transaction, decoded from the signed bytes in relay/. */
function mainDeliver(stepId: string): { spec: Hex; solution: Hex } {
  const hash = MAIN.steps.find((s: any) => s.id === stepId).tx.hash.toLowerCase();
  const outbox = JSON.parse(readFileSync("relay/outbox-11155111.json", "utf8"));
  const raw = outbox.find((t: any) => t.hash.toLowerCase() === hash).raw as Hex;
  const { args } = decodeFunctionData({ abi: ProofEscrowAbi, data: parseTransaction(raw).data as Hex }) as any;
  return { spec: args[1], solution: args[2] };
}

/** Job #1 as delivered on-chain (L6): spec, solution, weights and its two largest positions. */
function mainDeliverCalldata() {
  const { spec, solution } = mainDeliver("L6");
  const [w] = decodeAbiParameters([{ type: "int256[]" }, { type: "int256" }, { type: "int256[]" }, { type: "int256[]" }], solution) as unknown as [bigint[]];
  const order = w.map((v, i) => [v, i] as const).sort((a, b) => (a[0] > b[0] ? -1 : 1));
  return { spec, solution, w: [...w], top: order[0][1], second: order[1][1] };
}

main().catch((e) => {
  console.error("\nFATAL", e);
  process.exitCode = 1;
});

