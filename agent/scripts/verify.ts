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
import { MinVarianceVerifierAbi, ProofEscrowAbi, QEDClearingAbi, QEDLensAbi, QEDVaultAbi, TestUSDAbi } from "../src/abi/contracts.js";
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
  const failed = rows.filter((r) => !r.ok);
  writeFileSync(`${EVIDENCE}/verification.json`, JSON.stringify({ at: new Date().toISOString(), rpc: RPC, chainId, passed: rows.length - failed.length, failed: failed.length, rows }, null, 2));
  console.log(`\n${failed.length === 0 ? "ALL" : rows.length - failed.length + "/" + rows.length} CHECKS PASSED${failed.length ? ` — ${failed.length} FAILED` : ""}  (${rows.length} checks, report: ${EVIDENCE}/verification.json)\n`);
  if (failed.length) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
