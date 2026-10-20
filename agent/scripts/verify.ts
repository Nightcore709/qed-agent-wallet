/**
 * INDEPENDENT VERIFIER — re-derives every claim in the evidence manifest from a public RPC.
 * Needs no keys and trusts nothing in this repo except the source code it compiles.
 *
 *   npm run verify                                   (Ethereum Sepolia, public RPC)
 *   RPC_URL=https://… EVIDENCE=evidence/ethereum-sepolia npm run verify
 *
 * Checks, for the four outcomes:
 *   O1  the payment was sent BY the agent key, under a mandate signed by the vault OWNER and a
 *       certificate signed by the independent CO-SIGNER (signatures recovered from calldata), and the
 *       anchored evidence hash equals the hash of the published decision record;
 *   O2  the escrow job settled into the agent's vault, and the delivered portfolio passes the KKT
 *       check both on-chain (eth_call) and in an independent TypeScript re-implementation;
 *   O3  every attack transaction is a REVERTED receipt whose replayed custom error matches the claim;
 *       ring-fenced money only ever reached its creditor; the honeypot ring-fence is intact;
 *   O4  the bytecode at every deployed address equals this repository's compiled bytecode.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import {
  createPublicClient,
  decodeFunctionData,
  getAddress,
  http,
  keccak256,
  recoverAddress,
  type Abi,
  type Address,
  type Hex,
} from "viem";
import { CPMMPoolAbi, QEDTreasuryPolicyAbi, ExecutionBountyAbi, MaximalityBountyAbi, MinVarianceVerifierAbi, OptimalityBountyAbi, PrivateMinVarianceVerifierAbi, ProofEscrowAbi, QEDClearingAbi, QEDExecutionAbi, QEDLensAbi, QEDVaultAbi, TestUSDAbi } from "../src/abi/contracts.js";
import { dualBound, simulate, solve, type Hop, type VenueState } from "../src/engine/execution.js";
import { hashOrder, readVenues } from "../src/roles/trader.js";
import { encodeAbiParameters } from "viem";
import { CIRCUIT, attestationDigest, verifyOffchain, shutdownProver } from "../src/engine/privateMinvar.js";
import { checkNetting, type Obligation } from "../src/engine/netting.js";
import { decodeRevert } from "../src/chain.js";
import { checkCertificate } from "../src/engine/minvar.js";
import { canonical } from "../src/protocol/records.js";
import { decodeAbiParameters } from "viem";

const EVIDENCE = process.env.EVIDENCE ?? "evidence/ethereum-sepolia";
const manifest = JSON.parse(readFileSync(`${EVIDENCE}/manifest.json`, "utf8"));
const chainId: number = manifest.network.chainId;
const RPC = process.env.RPC_URL ?? (chainId === 11155111 ? "https://ethereum-sepolia-rpc.publicnode.com" : "http://127.0.0.1:8545");
const pub = createPublicClient({ transport: http(RPC, { retryCount: 5, retryDelay: 1000 }) });
// Replaying a reverted transaction "on the state just before its block" needs historical state, which pruned
// public nodes drop after ~128 blocks. These public endpoints serve archive state for Sepolia; override with ARCHIVE_RPC.
const ARCHIVE = (process.env.ARCHIVE_RPC ?? (chainId === 11155111 ? "https://sepolia.drpc.org,https://1rpc.io/sepolia,https://sepolia.gateway.tenderly.co" : RPC))
  .split(",")
  .map((u) => createPublicClient({ transport: http(u.trim(), { retryCount: 3, retryDelay: 1000 }) }));
const NO_STATE = /historical state|missing trie node|header not found|state.*not available|pruned/i;
const dep = manifest.contracts;

type Row = { check: string; outcome: string; ok: boolean; detail: string };
const rows: Row[] = [];
const ok = (outcome: string, check: string, cond: boolean, detail = "") => {
  rows.push({ outcome, check, ok: cond, detail });
  console.log(`${cond ? "  ✓" : "  ✗"} [${outcome}] ${check}${detail ? `  — ${detail}` : ""}`);
  // in CI, a failed check is also a workflow annotation, readable from the API without downloading logs
  if (!cond && process.env.GITHUB_ACTIONS) console.log(`::error title=verify ${outcome}::${check}${detail ? ` (${detail})` : ""}`.replace(/\r?\n/g, " "));
};

const step = (id: string) => manifest.steps.find((s: any) => s.id === id);

async function verifyBytecode(
  addrs: Record<string, Address> = dep,
  art: Record<string, string> = { token: "TestUSD.sol/TestUSD", verifier: "MinVarianceVerifier.sol/MinVarianceVerifier", escrow: "ProofEscrow.sol/ProofEscrow", vault: "QEDVault.sol/QEDVault", honeypotVault: "QEDVault.sol/QEDVault", lens: "QEDLens.sol/QEDLens" },
) {
  for (const [k, path] of Object.entries(art)) {
    const f = `out/${path}.json`;
    if (!existsSync(f)) {
      ok("O4", `bytecode of ${k}`, false, "run `forge build` first");
      continue;
    }
    const a = JSON.parse(readFileSync(f, "utf8"));
    const local: string = a.deployedBytecode.object.slice(2);
    const onchain = ((await pub.getCode({ address: addrs[k] })) ?? "0x").slice(2);
    // mask immutables (e.g. token address, cached domain separator) at their declared offsets
    const mask = (code: string) => {
      let c = code;
      for (const refs of Object.values<any>(a.deployedBytecode.immutableReferences ?? {})) {
        for (const r of refs) c = c.slice(0, r.start * 2) + "00".repeat(r.length) + c.slice((r.start + r.length) * 2);
      }
      return c;
    };
    ok("O4", `on-chain bytecode of ${k} == this repo's compiled bytecode`, onchain.length === local.length && mask(onchain) === mask(local), `${addrs[k]} (${onchain.length / 2} bytes)`);
  }
}

async function verifySteps(steps: any[] = manifest.steps) {
  for (const s of steps) {
    if (!s.tx) continue;
    const r = await pub.getTransactionReceipt({ hash: s.tx.hash });
    const tx = await pub.getTransaction({ hash: s.tx.hash });
    const statusOk = r.status === s.tx.status && r.status === (s.expect === "revert" ? "reverted" : "success");
    const fromOk = getAddress(tx.from) === getAddress(s.tx.from);
    let errOk = true;
    let errName = "";
    if (s.expect === "revert") {
      // replay the exact call on the state just before its block to recover the custom error
      errOk = false;
      errName = "no archive RPC could replay";
      for (const client of [pub, ...ARCHIVE]) {
        try {
          await client.call({ account: tx.from, to: tx.to!, data: tx.input, blockNumber: r.blockNumber - 1n, gas: 16_000_000n });
          errName = "call succeeded on replay";
          break;
        } catch (e: any) {
          if (NO_STATE.test(String(e?.details ?? e?.message ?? e))) continue;
          errName = decodeRevert(e).name;
          errOk = errName === s.error?.name;
          break;
        }
      }
    }
    const outcome = (s.outcomes ?? []).join("+") || "-";
    ok(outcome, `${s.id} ${s.title}`, statusOk && fromOk && errOk, `${r.status}${s.expect === "revert" ? ` · ${errName}` : ""} · block ${r.blockNumber} · ${s.tx.hash.slice(0, 12)}…`);
  }
}

async function verifyOutcome1() {
  const s = step("L4");
  const tx = await pub.getTransaction({ hash: s.tx.hash });
  const { args } = decodeFunctionData({ abi: QEDVaultAbi as Abi, data: tx.input }) as any;
  const [m, ownerSig, c, cosignerSig] = args;
  const owner = (await pub.readContract({ address: dep.vault, abi: QEDVaultAbi, functionName: "owner" })) as Address;
  const agent = (await pub.readContract({ address: dep.vault, abi: QEDVaultAbi, functionName: "agent" })) as Address;
  const cosigner = (await pub.readContract({ address: dep.vault, abi: QEDVaultAbi, functionName: "cosigner" })) as Address;
  const mDigest = (await pub.readContract({ address: dep.lens, abi: QEDLensAbi, functionName: "mandateDigest", args: [dep.vault, m] })) as Hex;
  const cDigest = (await pub.readContract({ address: dep.lens, abi: QEDLensAbi, functionName: "certificateDigest", args: [dep.vault, c] })) as Hex;
  const mSigner = await recoverAddress({ hash: mDigest, signature: ownerSig });
  const cSigner = await recoverAddress({ hash: cDigest, signature: cosignerSig });
  ok("O1", "payment transaction was sent by the AGENT key (msg.sender)", getAddress(tx.from) === getAddress(agent), tx.from);
  ok("O1", "agent, owner and co-signer are three distinct keys", new Set([agent, owner, cosigner].map((x) => x.toLowerCase())).size === 3, `agent ${agent.slice(0, 8)} · owner ${owner.slice(0, 8)} · cosigner ${cosigner.slice(0, 8)}`);
  ok("O1", "mandate signature recovers to the vault OWNER", getAddress(mSigner) === getAddress(owner), mSigner);
  ok("O1", "certificate signature recovers to the independent CO-SIGNER", getAddress(cSigner) === getAddress(cosigner), cSigner);
  const rec = step("L3").artifacts?.[0];
  if (rec && existsSync(rec.path)) {
    const file = JSON.parse(readFileSync(rec.path, "utf8"));
    const recomputed = keccak256(new TextEncoder().encode(canonical(file.core)));
    ok("O1", "on-chain evidenceHash == keccak256(published decision record)", recomputed === c.evidenceHash && rec.hash === c.evidenceHash, `${c.evidenceHash.slice(0, 18)}…`);
  }
}

async function verifyOutcome2() {
  const s = step("L6");
  const tx = await pub.getTransaction({ hash: s.tx.hash });
  const { args } = decodeFunctionData({ abi: ProofEscrowAbi as Abi, data: tx.input }) as any;
  const [jobId, spec, solution] = args;
  const job = (await pub.readContract({ address: dep.escrow, abi: ProofEscrowAbi, functionName: "getJob", args: [jobId] })) as any;
  ok("O2", `escrow job #${jobId} is Settled and paid the agent's vault`, Number(job.status) === 2 && getAddress(job.payee) === getAddress(dep.vault), `price ${Number(job.price) / 1e6} tUSD`);
  const [n, cov, tol, universe] = decodeAbiParameters([{ type: "uint256" }, { type: "int256[]" }, { type: "uint256" }, { type: "bytes32" }], spec);
  const [w, nu, mu, L] = decodeAbiParameters([{ type: "int256[]" }, { type: "int256" }, { type: "int256[]" }, { type: "int256[]" }], solution);
  const rep = checkCertificate({ n: Number(n), cov: [...cov], tol, universe }, { w: [...w], nu, mu: [...mu], L: [...L] });
  ok("O2", "delivered portfolio passes an INDEPENDENT off-chain KKT re-check", rep.ok, `duality gap ${rep.dualityGap} · max residual ${rep.maxStationarityResidual} · ε-bound ${rep.optimalityBound.toExponential(2)}`);
  const digest = (await pub.readContract({ address: dep.verifier, abi: MinVarianceVerifierAbi, functionName: "verify", args: [spec, solution] })) as Hex;
  ok("O2", "on-chain verifier re-accepts the certificate today (eth_call)", BigInt(digest) === BigInt(job.resultDigest), `certified variance ${(Number(BigInt(digest)) / 1e18).toFixed(8)}`);
  ok("O2", "solution hash recorded on-chain matches the delivered calldata", job.solutionHash === keccak256(solution), job.solutionHash.slice(0, 18) + "…");
}

async function verifyOutcome3() {
  const attacks = manifest.steps.filter((s: any) => s.tx && s.expect === "revert");
  ok("O3", `${attacks.length} adversarial transactions are on-chain as REVERTED receipts`, attacks.every((s: any) => s.tx.status === "reverted"));
  const snap = (await pub.readContract({ address: dep.lens, abi: QEDLensAbi, functionName: "snapshot", args: [dep.vault] })) as any;
  ok("O3", "vault balance ≥ ring-fenced liabilities (solvency invariant, live)", BigInt(snap.balance) >= BigInt(snap.protectedBalance), `balance ${Number(snap.balance) / 1e6} · ring-fenced ${Number(snap.protectedBalance) / 1e6}`);
  const l1 = (await pub.readContract({ address: dep.vault, abi: QEDVaultAbi, functionName: "getLiability", args: [1n] })) as any;
  const settled = await pub.getContractEvents({ address: dep.vault, abi: QEDVaultAbi, eventName: "LiabilitySettled", fromBlock: BigInt(dep.deployBlock) });
  const s1 = (settled as any[]).find((e) => e.args.id === 1n);
  ok("O3", "CloudCo's ring-fenced 70 tUSD reached CloudCo — and nobody else", Number(l1.status) === 2 && !!s1 && getAddress(s1.args.creditor) === getAddress(l1.creditor) && s1.args.amount === 70_000_000n, s1 ? `settled by ${s1.args.settledBy.slice(0, 10)}… (a stranger) while paused` : "not settled yet");
  const hp = (await pub.readContract({ address: dep.lens, abi: QEDLensAbi, functionName: "snapshot", args: [dep.honeypotVault] })) as any;
  ok("O3", "HONEYPOT: published-key vault still holds its full ring-fence", BigInt(hp.protectedBalance) === 90_000_000n && BigInt(hp.balance) >= 90_000_000n, `ring-fenced ${Number(hp.protectedBalance) / 1e6} · balance ${Number(hp.balance) / 1e6} · 24h blast radius ${Number(hp.blastRadius24h) / 1e6}`);
  const mallory = manifest.actors.mallory as Address;
  const malloryBal = (await pub.readContract({ address: dep.token, abi: TestUSDAbi, functionName: "balanceOf", args: [mallory] })) as bigint;
  const malloryIn = await pub.getContractEvents({ address: dep.token, abi: TestUSDAbi, eventName: "Transfer", args: { to: mallory }, fromBlock: BigInt(dep.deployBlock) });
  const fromVaults = (malloryIn as any[]).filter((e) => [dep.vault, dep.honeypotVault, dep.escrow].map((x: string) => x.toLowerCase()).includes(e.args.from.toLowerCase()));
  ok("O3", "Mallory received ZERO tUSD from either vault or the escrow", fromVaults.length === 0, `Mallory balance ${Number(malloryBal) / 1e6} tUSD (only the test faucet/mint)`);
}

/** The QED Clearing run (proof-gated multilateral netting), if its evidence is present. */
async function verifyClearing() {
  const path = `${EVIDENCE}/clearing/manifest.json`;
  if (!existsSync(path)) return;
  const cm = JSON.parse(readFileSync(path, "utf8"));
  const cd = cm.contracts as { token: Address; clearing: Address; deployBlock: string };
  console.log("\n— QED Clearing: bytecode —");
  await verifyBytecode({ clearingToken: cd.token, clearing: cd.clearing }, { clearingToken: "TestUSD.sol/TestUSD", clearing: "QEDClearing.sol/QEDClearing" });
  console.log("\n— QED Clearing: every recorded transaction —");
  await verifySteps(cm.steps);
  console.log("\n— QED Clearing: the netting is value-preserving and provably maximal —");
  const n6 = cm.steps.find((x: any) => x.id === "N6");
  const tx = await pub.getTransaction({ hash: n6.tx.hash });
  const { args } = decodeFunctionData({ abi: QEDClearingAbi as Abi, data: tx.input }) as any;
  const p = args[0];
  const members = (await pub.readContract({ address: cd.clearing, abi: QEDClearingAbi, functionName: "allMembers" })) as Address[];
  const idx = (a: Address) => members.findIndex((m) => m.toLowerCase() === a.toLowerCase());
  const obs: Obligation[] = [];
  for (let i = 0; i < p.ids.length; i++) {
    const o = (await pub.readContract({ address: cd.clearing, abi: QEDClearingAbi, functionName: "getObligation", args: [p.ids[i]] })) as any;
    obs.push({ id: p.ids[i], debtor: idx(o.debtor), creditor: idx(o.creditor), amount: BigInt(p.amounts[i]) });
  }
  const rep = checkNetting(members.length, obs, { x: [...p.x].map(BigInt), potential: [...p.potential].map(BigInt), y: [...p.y].map(BigInt) });
  ok("O3", "submitted netting re-checked INDEPENDENTLY: net positions unchanged, dual feasible, Σx = Σd·y (maximal)", rep.ok, `cleared ${Number(rep.cleared) / 1e6} = dual bound ${Number(rep.bound) / 1e6} tUSD`);
  const netted = (await pub.getContractEvents({ address: cd.clearing, abi: QEDClearingAbi, eventName: "Netted", fromBlock: BigInt(cd.deployBlock) })) as any[];
  ok("O4", "exactly one netting executed on-chain, matching the proof", netted.length === 1 && netted[0].args.cleared === rep.cleared, `gross ${Number(netted[0]?.args.grossBefore) / 1e6} → ${Number(netted[0]?.args.grossAfter) / 1e6} tUSD`);
  const terms = (await pub.readContract({ address: cd.clearing, abi: QEDClearingAbi, functionName: "TERMS" })) as Hex;
  const joined = (await pub.getContractEvents({ address: cd.clearing, abi: QEDClearingAbi, eventName: "Joined", fromBlock: BigInt(cd.deployBlock) })) as any[];
  ok("O4", "every member consented on-chain to the netting terms", joined.length === members.length && joined.every((e) => e.args.terms === terms), `${joined.length} Joined events`);
  const open = (await pub.readContract({ address: cd.clearing, abi: QEDClearingAbi, functionName: "openCount" })) as bigint;
  const bal = await Promise.all(members.map((m) => pub.readContract({ address: cd.token, abi: TestUSDAbi, functionName: "balanceOf", args: [m] }) as Promise<bigint>));
  const finalPos = cm.final?.netPositions ? Object.values<string>(cm.final.netPositions).map(BigInt) : [];
  ok("O4", "all debts cleared, and every agent ends holding exactly its net position", open === 0n && finalPos.length === members.length && bal.every((b, k) => b === (finalPos[k] > 0n ? finalPos[k] : 0n)), `open obligations ${open} · balances ${bal.map((b) => Number(b) / 1e6).join(" / ")}`);
  const mal = cm.actors.mallory as Address;
  const malIn = await pub.getContractEvents({ address: cd.token, abi: TestUSDAbi, eventName: "Transfer", args: { to: mal }, fromBlock: BigInt(cd.deployBlock) });
  ok("O3", "Mallory received ZERO tUSD from the clearing run", (malIn as any[]).length === 0);
}

async function main() {
  console.log(`\nQED independent verification · ${manifest.network.name} (chain ${chainId}) · RPC ${RPC}\n`);
  const live = await pub.getChainId();
  ok("O4", "connected to the network the evidence claims", live === chainId, `chainId ${live}`);
  console.log("\n— bytecode —");
  await verifyBytecode();
  console.log("\n— every recorded transaction —");
  await verifySteps();
  console.log("\n— Outcome 1: separate agent key + independent policy certificate —");
  await verifyOutcome1();
  console.log("\n— Outcome 2: paid work settled by proof —");
  await verifyOutcome2();
  console.log("\n— Outcome 3: adversaries cannot breach liabilities or signed terms —");
  await verifyOutcome3();
  await verifyClearing();
  await verifyPrivate();
  await verifyExecution();
  await shutdownProver();
  const failed = rows.filter((r) => !r.ok);
  writeFileSync(`${EVIDENCE}/verification.json`, JSON.stringify({ at: new Date().toISOString(), rpc: RPC, chainId, passed: rows.length - failed.length, failed: failed.length, rows }, null, 2));
  console.log(`\n${failed.length === 0 ? "ALL" : rows.length - failed.length + "/" + rows.length} CHECKS PASSED${failed.length ? ` — ${failed.length} FAILED` : ""}  (${rows.length} checks, report: ${EVIDENCE}/verification.json)\n`);
  if (process.env.GITHUB_ACTIONS) console.log(`::notice title=verify::${rows.length - failed.length}/${rows.length} checks passed against ${RPC}`);
  if (failed.length) process.exit(1);
}

/** The QED Private run (zero-knowledge optimality + theorem bounties), if its evidence is present. */
async function verifyPrivate() {
  const path = `${EVIDENCE}/private/manifest.json`;
  if (!existsSync(path)) return;
  const pm = JSON.parse(readFileSync(path, "utf8"));
  const k = pm.contracts as Record<string, Address>;
  console.log("\n— QED Private: bytecode —");
  await verifyBytecode(
    { groth16: k.groth16, privateVerifier: k.privateVerifier, optimalityBounty: k.optimalityBounty, maximalityBounty: k.maximalityBounty },
    { groth16: "Groth16Verifier.sol/Groth16Verifier", privateVerifier: "PrivateMinVarianceVerifier.sol/PrivateMinVarianceVerifier", optimalityBounty: "OptimalityBounty.sol/OptimalityBounty", maximalityBounty: "MaximalityBounty.sol/MaximalityBounty" },
  );
  const vk = JSON.parse(readFileSync(CIRCUIT.vkey, "utf8"));
  const sol = readFileSync("contracts/src/verifiers/zk/Groth16Verifier.sol", "utf8");
  ok("O4", "the deployed Groth16 verifier embeds the committed verification key (circuits/private_minvar.vkey.json)", sol.includes(vk.vk_delta_2[0][0]) && sol.includes(vk.IC[4][1]), `nPublic ${vk.nPublic} · IC points ${vk.IC.length}`);
  const wired = (await pub.readContract({ address: k.privateVerifier, abi: PrivateMinVarianceVerifierAbi, functionName: "groth16" })) as Address;
  const vendor = (await pub.readContract({ address: k.privateVerifier, abi: PrivateMinVarianceVerifierAbi, functionName: "dataVendor" })) as Address;
  ok("O4", "PrivateMinVarianceVerifier is wired to that Groth16 verifier and to Helix as data vendor", getAddress(wired) === getAddress(k.groth16) && getAddress(vendor) === getAddress(pm.actors.helix), `vendor ${vendor}`);
  console.log("\n— QED Private: every recorded transaction —");
  await verifySteps(pm.steps);
  console.log("\n— QED Private: paid on a zero-knowledge proof, re-verified independently —");
  const z3 = pm.steps.find((x: any) => x.id === "Z3");
  const tx = await pub.getTransaction({ hash: z3.tx.hash });
  const { args } = decodeFunctionData({ abi: ProofEscrowAbi as Abi, data: tx.input }) as any;
  const [jobId, spec, solution] = args as [bigint, Hex, Hex];
  const [dataCommitment, universe, provider, vendorSig] = decodeAbiParameters([{ type: "uint256" }, { type: "bytes32" }, { type: "address" }, { type: "bytes" }], spec) as any;
  const [a, b, c, wc, variance] = decodeAbiParameters([{ type: "uint256[2]" }, { type: "uint256[2][2]" }, { type: "uint256[2]" }, { type: "uint256" }, { type: "uint256" }], solution) as any;
  const proof = { pi_a: [a[0].toString(), a[1].toString(), "1"], pi_b: [[b[0][1].toString(), b[0][0].toString()], [b[1][1].toString(), b[1][0].toString()], ["1", "0"]], pi_c: [c[0].toString(), c[1].toString(), "1"], protocol: "groth16", curve: "bn128" };
  const signals = [wc, variance, dataCommitment, BigInt(provider)].map((x: bigint) => x.toString());
  ok("O2", "the Groth16 proof verifies OFF-CHAIN with snarkjs against the committed verification key", await verifyOffchain(vk, { proof, publicSignals: signals }), `variance ${(Number(variance) / 1e36).toFixed(10)} · provider ${provider}`);
  const signer = await recoverAddress({ hash: keccak256(new Uint8Array([...new TextEncoder().encode("\x19Ethereum Signed Message:\n32"), ...hexToBytes(attestationDigest(BigInt(chainId), dataCommitment, universe))])), signature: vendorSig });
  ok("O2", "the data commitment carries Helix's attestation (signature recovered from calldata)", getAddress(signer) === getAddress(pm.actors.helix), `${dataCommitment.toString(16).slice(0, 12)}… attested by ${signer}`);
  ok("O1", "the proof is bound to the QED agent, which sent the delivery", getAddress(provider) === getAddress(pm.actors.qed) && getAddress(tx.from) === getAddress(pm.actors.qed));
  const job = (await pub.readContract({ address: k.escrow, abi: ProofEscrowAbi, functionName: "getJob", args: [jobId] })) as any;
  ok("O2", "the same ProofEscrow that settled job #1 settled this job into QED's vault, recording the proof's digest", Number(job.status) === 2 && getAddress(job.payee) === getAddress(k.vault) && getAddress(job.verifier) === getAddress(k.privateVerifier) && job.solutionHash === keccak256(solution), `job #${jobId} · ${Number(job.price) / 1e6} tUSD → ${job.payee}`);
  console.log("\n— QED Private: theorems with money on them —");
  const balOf = (x: Address) => pub.readContract({ address: k.token, abi: TestUSDAbi, functionName: "balanceOf", args: [x] }) as Promise<bigint>;
  const [obBal, mbBal] = [await balOf(k.optimalityBounty), await balOf(k.maximalityBounty)];
  const refuted = [
    ...((await pub.getContractEvents({ address: k.optimalityBounty, abi: OptimalityBountyAbi, eventName: "Refuted", fromBlock: BigInt(k.deployBlock) })) as any[]),
    ...((await pub.getContractEvents({ address: k.maximalityBounty, abi: MaximalityBountyAbi, eventName: "Refuted", fromBlock: BigInt(k.deployBlock) })) as any[]),
  ];
  const ver = (await pub.readContract({ address: k.optimalityBounty, abi: OptimalityBountyAbi, functionName: "verifier" })) as Address;
  ok("O4", "the optimality bounty guards the verifier that settled job #1", getAddress(ver) === getAddress(dep.verifier), ver);
  ok("O3", "both bounties are still funded and nobody has refuted either theorem", refuted.length === 0 && obBal > 0n && mbBal > 0n, `${Number(obBal) / 1e6} + ${Number(mbBal) / 1e6} tUSD unclaimed today`);
  const mal = pm.actors.mallory as Address;
  const malIn = (await pub.getContractEvents({ address: k.token, abi: TestUSDAbi, eventName: "Transfer", args: { to: mal }, fromBlock: BigInt(k.deployBlock) })) as any[];
  const fromUs = malIn.filter((e) => [k.escrow, k.optimalityBounty, k.maximalityBounty].map((x) => x.toLowerCase()).includes(e.args.from.toLowerCase()));
  ok("O3", "Mallory received ZERO tUSD from the escrow or either bounty", fromUs.length === 0, `${malIn.length} faucet transfer(s) only`);
}


/** Run 4: best execution proved on-chain, re-proved here from public state with no keys. */
async function verifyExecution() {
  const path = `${EVIDENCE}/execution/manifest.json`;
  if (!existsSync(path)) return;
  const em = JSON.parse(readFileSync(path, "utf8"));
  const k = em.contracts as { usd: Address; eur: Address; eth: Address; pools: Address[]; vault: Address; reserve: Address; execution: Address; lens: Address; deployBlock: string };
  console.log("\n— QED Execute: bytecode —");
  const addrs: Record<string, Address> = { eur: k.eur, eth: k.eth, vault: k.vault, reserve: k.reserve, execution: k.execution };
  const art: Record<string, string> = { eur: "TestToken.sol/TestToken", eth: "TestToken.sol/TestToken", vault: "QEDVault.sol/QEDVault", reserve: "QEDVault.sol/QEDVault", execution: "QEDExecution.sol/QEDExecution" };
  k.pools.forEach((p, i) => {
    addrs[`venue${i}`] = p;
    art[`venue${i}`] = "CPMMPool.sol/CPMMPool";
  });
  await verifyBytecode(addrs, art);
  const agent = (await pub.readContract({ address: k.vault, abi: QEDVaultAbi, functionName: "agent" })) as Address;
  const wiredVault = (await pub.readContract({ address: k.execution, abi: QEDExecutionAbi, functionName: "vault" })) as Address;
  const venues = (await pub.readContract({ address: k.execution, abi: QEDExecutionAbi, functionName: "venues" })) as any[];
  const vsh = (await pub.readContract({ address: k.execution, abi: QEDExecutionAbi, functionName: "venueSetHash" })) as Hex;
  const enc = keccak256(encodeAbiParameters([{ type: "tuple[]", components: [{ name: "pool", type: "address" }, { name: "token0", type: "address" }, { name: "token1", type: "address" }, { name: "feeBps", type: "uint16" }] }], [venues]));
  ok("O1", "QEDExecution is the treasury vault's agent and is bound to that vault", getAddress(agent) === getAddress(k.execution) && getAddress(wiredVault) === getAddress(k.vault), `agent ${agent}`);
  ok("O4", "the venue set is exactly the five deployed pools, and its hash is what every order committed to", venues.length === k.pools.length && venues.every((v, i) => getAddress(v.pool) === getAddress(k.pools[i])) && enc === vsh, vsh.slice(0, 18) + "…");
  console.log("\n— QED Execute: every recorded transaction —");
  await verifySteps(em.steps);

  console.log("\n— QED Execute: best execution re-proved independently from public state —");
  const historical = async <T>(f: (c: any) => Promise<T>): Promise<T> => {
    let last: unknown;
    for (const client of [pub, ...ARCHIVE]) {
      try {
        return await f(client);
      } catch (e: any) {
        last = e;
        if (!NO_STATE.test(String(e?.details ?? e?.message ?? e))) throw e;
      }
    }
    throw last;
  };
  for (const id of ["E1", "E2", "PE1", "PE2", "QE1"]) {
    const st = em.steps.find((x: any) => x.id === id);
    if (!st) continue;
    const tx = await pub.getTransaction({ hash: st.tx.hash });
    const rc = await pub.getTransactionReceipt({ hash: st.tx.hash });
    // QE1 went through QEDTreasuryPolicy.convert, which takes exactly QEDExecution.trade's arguments
    const { args } = decodeFunctionData({ abi: (getAddress(tx.to!) === getAddress(k.execution) ? QEDExecutionAbi : QEDTreasuryPolicyAbi) as Abi, data: tx.input }) as any;
    const [, , cert, , order, route, prices] = args;
    // Pre-trade reserves: the state at the end of the previous block, then, for every pool, the last Sync emitted
    // earlier in the same block (another trade, Mallory, anyone) — PE1 and PE2 share a block.
    const before = rc.blockNumber - 1n;
    const vs0: VenueState[] = await historical((client) => readVenues(client, k.execution, before));
    const syncs = (await pub.getContractEvents({ address: k.pools, abi: CPMMPoolAbi, eventName: "Sync", fromBlock: rc.blockNumber, toBlock: rc.blockNumber })) as any[];
    const vs: VenueState[] = vs0.map((v) => {
      const last = syncs.filter((x) => getAddress(x.address) === getAddress(v.pool) && x.transactionIndex < rc.transactionIndex).sort((a, b) => a.logIndex - b.logIndex).at(-1);
      return last ? { ...v, r0: BigInt(last.args.reserve0), r1: BigInt(last.args.reserve1) } : v;
    });
    const sameBlock = syncs.filter((x) => x.transactionIndex < rc.transactionIndex).length;
    const pm = new Map<string, bigint>(prices.map((p: any) => [p.token.toLowerCase(), BigInt(p.value)]));
    const B = dualBound(vs, BigInt(cert.amount), k.usd, order.tokenOut, pm);
    const ev = (await pub.getContractEvents({ address: k.execution, abi: QEDExecutionAbi, eventName: "BestExecution", fromBlock: rc.blockNumber, toBlock: rc.blockNumber })) as any[];
    const e = ev.find((x) => x.transactionHash.toLowerCase() === st.tx.hash.toLowerCase())?.args;
    const hops: Hop[] = route.map((h: any) => ({ venue: Number(h.venue), zeroForOne: h.zeroForOne, amountIn: BigInt(h.amountIn) }));
    const sim = simulate(vs, hops, k.usd, order.tokenOut, BigInt(cert.amount));
    const own = solve(vs, k.usd, order.tokenOut, BigInt(cert.amount));
    ok("O1", `${id}: the bound recomputed here from the pre-trade reserves equals the bound the contract enforced`, !!e && e.bound === B, `B = ${Number(B) / 1e6} tEUR (state after block ${before}${sameBlock ? ` and ${sameBlock} earlier pool update(s) in block ${rc.blockNumber}` : ""})`);
    ok("O1", `${id}: replaying the calldata's route on those reserves gives exactly the output the chain delivered`, !!e && sim.ok && sim.amountOut === e.amountOut, `${Number(sim.amountOut) / 1e6} tEUR`);
    ok("O1", `${id}: realised output within the order's tolerance of the bound, and of an independent optimum`, !!e && e.amountOut * 1_000_000n >= B * (1_000_000n - BigInt(order.tolerancePpm)) && e.amountOut * 1_000_000n >= own.sim.amountOut * 999_999n, `gap ${(Number(B - e.amountOut) / Number(B) * 1e6).toFixed(3)} ppm to the bound; independent route ${Number(own.sim.amountOut) / 1e6}`);
    ok("O1", `${id}: the co-signer's certificate commits to this exact order (recipient, floor, τ, venue set)`, cert.ref === hashOrder(order) && order.venueSetHash === vsh && getAddress(order.recipient) === getAddress(k.reserve), `order ${cert.ref.slice(0, 12)}… · floor ${Number(order.minOut) / 1e6}`);
  }
  if (em.policyRun) {
    console.log("\n— QED Execute: the agent decided under a standing policy —");
    const pe2 = em.steps.find((x: any) => x.id === "PE2");
    const target = BigInt(em.policyRun.policy.targetFree);
    const freeAt = (await historical((client) => client.readContract({ address: k.reserve, abi: QEDVaultAbi, functionName: "freeBalance", blockNumber: BigInt(pe2.tx.blockNumber) }))) as bigint;
    const sent = (await pub.getTransaction({ hash: pe2.tx.hash })).from;
    ok("O1", "the policy trades were sent by the operator key, and after the second the euro reserve's free balance met the owner's target", getAddress(sent) === getAddress(em.actors.operator) && freeAt >= target, `free ${Number(freeAt) / 1e6} tEUR ≥ target ${Number(target) / 1e6} at block ${pe2.tx.blockNumber}`);
  }
  const tp = (em.contracts as any).treasuryPolicy as Address | undefined;
  if (tp && em.policyChain) {
    console.log("\n— QED Execute: the owner's policy, enforced by a contract (Run 4d) —");
    await verifyBytecode({ treasuryPolicy: tp }, { treasuryPolicy: "QEDTreasuryPolicy.sol/QEDTreasuryPolicy" });
    const op = (await pub.readContract({ address: k.execution, abi: QEDExecutionAbi, functionName: "operator" })) as Address;
    const [pExec, pReserve, pAgent] = (await Promise.all(["execution", "reserve", "agent"].map((f) => pub.readContract({ address: tp, abi: QEDTreasuryPolicyAbi, functionName: f as any })))) as Address[];
    ok("O1", "QEDTreasuryPolicy is QEDExecution's operator: the agent's key can trade only through the policy", getAddress(op) === getAddress(tp) && getAddress(pExec) === getAddress(k.execution) && getAddress(pReserve) === getAddress(k.reserve) && getAddress(pAgent) === getAddress(em.actors.operator), `operator ${op}`);
    const qe1 = em.steps.find((x: any) => x.id === "QE1");
    const rc = await pub.getTransactionReceipt({ hash: qe1.tx.hash });
    const evs = (await pub.getContractEvents({ address: tp, abi: QEDTreasuryPolicyAbi, eventName: "PolicyConversion", fromBlock: rc.blockNumber, toBlock: rc.blockNumber })) as any[];
    const e = evs.find((x) => x.transactionHash.toLowerCase() === qe1.tx.hash.toLowerCase())?.args;
    const pol = (await historical((client) => client.readContract({ address: tp, abi: QEDTreasuryPolicyAbi, functionName: "policy", blockNumber: rc.blockNumber }))) as any;
    const [target, , , kappa, slack] = pol as [bigint, bigint, bigint, number, number];
    const a = e ? BigInt(e.amountIn) : 0n;
    const out = e ? BigInt(e.amountOut) : 0n;
    const smaller = a - (a * BigInt(slack)) / 10_000n;
    ok("O1", "QE1: every clause of the on-chain policy re-checked from the event and the policy in force at that block", !!e && BigInt(e.freeBefore) < target && out * 10_000n >= BigInt(e.midOut) * (10_000n - BigInt(kappa)) && BigInt(e.freeBefore) * a + out * smaller < target * a && BigInt(e.freeAfter) === BigInt(e.freeBefore) + out && BigInt(e.freeAfter) >= target, e ? `free ${Number(e.freeBefore) / 1e6} → ${Number(e.freeAfter) / 1e6} tEUR (target ${Number(target) / 1e6}); cost ${((1 - Number(out) / Number(e.midOut)) * 1e4).toFixed(1)} bps ≤ ${kappa}` : "event missing");
  }
  console.log("\n— QED Execute: nothing leaked —");
  const bal = (t: Address, a: Address) => pub.readContract({ address: t, abi: TestUSDAbi, functionName: "balanceOf", args: [a] }) as Promise<bigint>;
  const held = await Promise.all([k.usd, k.eur, k.eth].map((t) => bal(t, k.execution)));
  ok("O3", "the execution module holds nothing (tUSD, tEUR, tETH all zero)", held.every((x) => x === 0n));
  const mal = em.actors.mallory as Address;
  const fromModule = (await pub.getContractEvents({ address: k.eur, abi: TestUSDAbi, eventName: "Transfer", args: { from: k.execution }, fromBlock: BigInt(k.deployBlock) })) as any[];
  ok("O3", "every tEUR the module ever sent went to the euro reserve; none to Mallory", fromModule.length >= 2 && fromModule.every((x) => getAddress(x.args.to) === getAddress(k.reserve)) && !fromModule.some((x) => getAddress(x.args.to) === getAddress(mal)), `${fromModule.length} transfers`);
  const kb = (em.contracts as any).executionBounty as Address | undefined;
  if (kb) {
    console.log("\n— QED Execute: money on Theorem 12.3 —");
    await verifyBytecode({ executionBounty: kb }, { executionBounty: "ExecutionBounty.sol/ExecutionBounty" });
    const src = (await pub.readContract({ address: kb, abi: ExecutionBountyAbi, functionName: "execution" })) as Address;
    const poolNow = await bal(k.usd, kb);
    const refuted = (await pub.getContractEvents({ address: kb, abi: ExecutionBountyAbi, eventName: "Refuted", fromBlock: BigInt(em.bounty.deployBlock) })) as any[];
    ok("O4", "the execution bounty takes its bound from the deployed QEDExecution", getAddress(src) === getAddress(k.execution), src);
    ok("O3", "the execution bounty is still funded and nobody has refuted Theorem 12.3", refuted.length === 0 && poolNow > 0n, `${Number(poolNow) / 1e6} tUSD unclaimed today`);
  }
  const l = (await pub.readContract({ address: k.reserve, abi: QEDVaultAbi, functionName: "getLiability", args: [1n] })) as any;
  ok("O3", "the euro reserve ring-fences 15 tEUR for CloudCo", getAddress(l.creditor) === getAddress(em.actors.cloudco) && l.amount === 15_000_000n && Number(l.status) === 1, `liability #1 · due ${new Date(Number(l.dueAt) * 1000).toISOString().slice(0, 10)}`);
}

function hexToBytes(h: Hex): Uint8Array {
  const s = h.slice(2);
  return Uint8Array.from({ length: s.length / 2 }, (_, i) => parseInt(s.slice(2 * i, 2 * i + 2), 16));
}

main().catch((e) => {
  console.error(e);
  if (process.env.GITHUB_ACTIONS) console.log(`::error title=verify crashed::${String(e?.shortMessage ?? e?.message ?? e).replace(/\r?\n/g, " ").slice(0, 900)}`);
  process.exit(1);
});
