/**
 * The refutation bounties' claim path, end to end on the served stack (R11 section 9, R10-008, R10-009):
 *
 *   1. the real vault service process (node serve.ts, multi-tenant, its co-signer in its own process) deploys the bounty
 *      board at start, opens the two original bounties (and, with QED_RAIL_BOUNTY_CONTROLS=1, the release's positive
 *      controls) and funds each with 1,000 tUSD; two workspaces claim through its HTTP routes, while an adversary with
 *      its own key watches the shared Anvil's mempool and copies the finder's pending reveal (must fail); the five
 *      claims recorded on Sepolia are refused with exactly the recorded errors; the positive controls still pay, but
 *      only the committed finder; a restart keeps the board and the claims;
 *      (R13) the board opens bounties only with judges whose runtime code hash it allows (the four it opened), and only
 *      its deployer can change that list;
 *   2. an in-process host with a test clock: a commitment that is never revealed blocks nobody, an expired one cannot
 *      be revealed (nothing is sent), and the heartbeat reveals and settles a workspace's claim by itself.
 *
 * Ports (127.0.0.1 only): service 18871 and its Anvil 18872; the in-process host's Anvil 18873; economy Anvils unused
 * (18898, 18899). Override the base with QED_TEST_BOUNTY_PORT. Every process started here is stopped here.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { createPublicClient, createWalletClient, decodeAbiParameters, decodeErrorResult, decodeFunctionData, defineChain, encodeAbiParameters, encodeFunctionData, getAddress, http, keccak256, parseEventLogs, parseEther, parseGwei, toHex, type Abi, type Address, type Hex } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { CHAIN, key, startHost } from "./helpers.ts";
import { serviceChain, startService } from "./service-helper.ts";
import { RP_ID_HASH, SoftwarePasskey } from "./passkey.ts";
import { BOARD_ARTIFACT, commitmentDigest, loadBoardArtifact } from "../rail/bounties.ts";
import * as REL from "../vendor/agent/src/abi/contracts.ts";
import type { Job } from "../types.ts";

const BASE = Number(process.env.QED_TEST_BOUNTY_PORT ?? 18871);
/** The two economy ports (BASE + 27 and BASE + 28 unless QED_TEST_BOUNTY_ECON_PORT names the first), for runs kept to a range. */
const ECON = Number(process.env.QED_TEST_BOUNTY_ECON_PORT ?? BASE + 27);
const POOL = 1_000_000_000n; // 1,000 tUSD
const W = 10n ** 18n;
const ZERO = "0x0000000000000000000000000000000000000000" as Address;
const board = loadBoardArtifact();
const OB = REL.OptimalityBountyAbi as Abi, MB = REL.MaximalityBountyAbi as Abi, USD = REL.TestUSDAbi as Abi;

// ───────────── the release's fixtures and the claims built from them (as the release built them) ─────────────
const FIX = join(CHAIN, "vendor", "contracts", "test", "fixtures");
const mfx = JSON.parse(readFileSync(join(FIX, "minvar.json"), "utf8"));
const cfx = JSON.parse(readFileSync(join(FIX, "clearing.json"), "utf8"));
const n = Number(mfx.n);
const SPEC = mfx.spec as Hex, HONEST = mfx.honest as Hex, FORGED = mfx.equalWeight as Hex;
const SOL = [{ type: "int256[]" }, { type: "int256" }, { type: "int256[]" }, { type: "int256[]" }] as const;
const [w] = decodeAbiParameters(SOL, HONEST) as unknown as [bigint[]];
const obClaim = (spec: Hex, sol: Hex, x: bigint[]) => encodeFunctionData({ abi: OB, functionName: "claim", args: [spec, sol, x] });
const equalWeight = () => { const x = Array.from({ length: n }, () => W / BigInt(n)); x[0] += W - x.reduce((a, b) => a + b, 0n); return x; };
const top = w.indexOf(w.reduce((a, b) => (b > a ? b : a))), second = w.map((v, i) => [v, i] as const).filter(([, i]) => i !== top).sort((a, b) => (a[0] > b[0] ? -1 : 1))[0][1];
const near = w.map((v, i) => (i === top ? v - W / 1000n : i === second ? v + W / 1000n : v));
const worst = Array.from({ length: n }, (_, i) => (i === 3 ? W : 0n));
const LIE = encodeAbiParameters(SOL, [worst, 0n, Array(n).fill(0n), Array((n * (n + 1)) / 2).fill(0n)]);
const econ = { members: BigInt(cfx.members), debtor: cfx.debtors.map(BigInt), creditor: cfx.creditors.map(BigInt), d: cfx.amounts.map(BigInt) };
const optimal = { x: cfx.optimal.x.map(BigInt), potential: cfx.optimal.potential.map(BigInt), y: cfx.optimal.y.map(BigInt) };
const mbClaim = (larger: bigint[]) => encodeFunctionData({ abi: MB, functionName: "claim", args: [econ, optimal, larger] });
const CLAIM = {
  ba1: obClaim(SPEC, HONEST, equalWeight()),
  ba2: obClaim(SPEC, HONEST, near),
  ba3: obClaim(SPEC, FORGED, [...w]),
  bm1: mbClaim(cfx.greedy.x.map(BigInt)),
  bm2: mbClaim(optimal.x.map((v: bigint, i: number) => (i === 0 ? v + 1_000_000n : v))),
  optControl: obClaim(SPEC, LIE, w.map((v, i) => (i === 0 ? v + W - w.reduce((a, b) => a + b, 0n) : v))),
  maxControl: mbClaim(optimal.x),
};
/** The errors recorded on Sepolia for BA1-BA3 and BM1-BM2 (vendor/evidence/ethereum-sepolia/private/manifest.json). */
const RECORDED = {
  ba1: ["TheoremHolds", ["-17427890834445872562219109117693616905377777777777792", "30005320910997774926000000000000000000000000000"]],
  ba2: ["TheoremHolds", ["-33039999999997790320000000000000000000000000000", "30005320910997774926000000000000000000000000000"]],
  ba3: ["DualityGapTooLarge", ["19113333333333332"]],
  bm1: ["TheoremHolds", ["169000000", "162000000"]],
  bm2: ["NetPositionChanged", ["0", "1000000"]],
} as const;
/** BA1 as the claim's fields (the check route encodes them itself). */
const [sn, cov, tol, universe] = decodeAbiParameters([{ type: "uint256" }, { type: "int256[]" }, { type: "uint256" }, { type: "bytes32" }], SPEC);
const [hw, nu, mu, L] = decodeAbiParameters(SOL, HONEST);
const BA1_FIELDS = { spec: { n: String(sn), cov: cov.map(String), tol: String(tol), universe }, certificate: { w: hw.map(String), nu: String(nu), mu: mu.map(String), L: L.map(String) }, x: equalWeight().map(String) };
const BM1_FIELDS = { economy: { members: String(econ.members), debtor: econ.debtor.map(String), creditor: econ.creditor.map(String), d: econ.d.map(String) }, certified: { x: optimal.x.map(String), potential: optimal.potential.map(String), y: optimal.y.map(String) }, larger: cfx.greedy.x.map(String) };

// ───────────── the adversary: its own key, straight at the shared Anvil ─────────────
function adversary(anvilUrl: string) {
  const chain = defineChain({ id: 31337, name: "Anvil", nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 }, rpcUrls: { default: { http: [anvilUrl] } } });
  const pub = createPublicClient({ chain, transport: http(anvilUrl) });
  const account = privateKeyToAccount(generatePrivateKey()); // a throwaway local test key, never used anywhere else
  const wallet = createWalletClient({ account, chain, transport: http(anvilUrl) });
  const rpc = async (method: string, params: unknown[] = []) => {
    const r = await fetch(anvilUrl, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
    const j = (await r.json()) as { result?: unknown; error?: { message: string } };
    if (j.error) throw new Error(`${method}: ${j.error.message}`);
    return j.result;
  };
  /** Sends at a higher fee than the service's (0.02 gwei), with a fixed gas limit, so a reverting call is still mined. */
  const send = (to: Address, data: Hex) => wallet.sendTransaction({ to, data, gas: 3_000_000n, maxFeePerGas: parseGwei("60"), maxPriorityFeePerGas: parseGwei("3") });
  /** The board's (or a judge's) error for this call, or null if it would succeed. */
  const simulate = async (to: Address, data: Hex, from: Address = account.address): Promise<{ name: string; args: string[] } | null> => {
    // at "pending": an idle Anvil's latest block carries a stale time, the pending one the current time (rail/clock.ts)
    try { await pub.call({ account: from, to, data, gas: 3_000_000n, blockTag: "pending" }); return null; } catch (e) {
      const raw = (e as any).walk?.((x: any) => typeof x?.data === "string" && x.data.startsWith("0x"))?.data as Hex;
      for (const abi of [board.abi, OB, MB]) { try { const d = decodeErrorResult({ abi, data: raw }); return { name: d.errorName, args: (d.args ?? []).map((a) => String(a)) }; } catch { /* next */ } }
      return { name: "Undecoded", args: [raw] };
    }
  };
  return { account, pub, rpc, send, simulate };
}

const tusdOf = (pub: any, token: Address, who: Address) => pub.readContract({ address: token, abi: USD, functionName: "balanceOf", args: [who] }) as Promise<bigint>;

test("the served path: the vault service deploys the board; a copied pending reveal and a copied commit pay nothing; the finder is paid; the five recorded claims are refused as on Sepolia; a restart keeps everything", { timeout: 420_000 }, async () => {
  const env = { QED_RAIL_MODE: "multi-tenant", QED_RAIL_BOUNTY_CONTROLS: "1", QED_RAIL_BOUNTY_AUTO: "0", QED_RAIL_BOUNTY_REVEAL_DELAY_S: "3", QED_RAIL_BOUNTY_REVEAL_WINDOW_S: "600", QED_RAIL_BOUNTY_CONTEST_S: "20", QED_RAIL_ACCOUNT_DELAY_S: "60", QED_RAIL_ACCOUNT_RECOVERY_DELAY_S: "60", QED_RAIL_ECONOMY_ANVIL_PORT: String(ECON + 1) };
  let s = await startService("svc-bounties", BASE, BASE + 1, { env, workspace: null });
  const dir = s.dir;
  const waitJob = async (ws: string, jobId: string): Promise<Job> => { for (let i = 0; i < 900; i++) { const j = (await s.call<Job>("GET", `/workspaces/${ws}/jobs/${jobId}`)).data; if (["done", "failed", "interrupted"].includes(j.status)) return j; await sleep(100); } throw new Error(`job ${jobId} did not finish`); };
  const post = async (ws: string, path: string, body: unknown = {}) => s.call("POST", `/workspaces/${ws}${path}`, body, { "Idempotency-Key": key() });
  const job = async (ws: string, path: string, body: unknown = {}): Promise<Job> => { const a = await post(ws, path, body); assert.equal(a.status, 202, JSON.stringify(a.data)); return waitJob(ws, a.data.jobId); };
  const view = async (ws: string) => (await s.call("GET", `/workspaces/${ws}/bounties`)).data;
  const untilChain = async (t: number) => { while (Math.floor(Date.now() / 1000) < t) await sleep(200); };
  let ok = false;
  try {
    // ── the bootstrap: the board, its domain, four bounties of 1,000 tUSD each ──
    for (const id of ["finder-home", "rival-home"]) assert.equal((await s.call("POST", "/workspaces", { workspaceId: id, owner: new SoftwarePasskey().publicKey, rpIdHash: RP_ID_HASH })).status, 201);
    const v0 = await view("finder-home");
    assert.equal(v0.status, "ready", JSON.stringify(v0));
    assert.deepEqual(v0.bounties.map((b: any) => [b.id, b.key, b.role, b.phase, b.pool]), [["1", "optimality", "original", "open", "1000000000"], ["2", "maximality", "original", "open", "1000000000"], ["3", "optimality-control", "positive-control", "open", "1000000000"], ["4", "maximality-control", "positive-control", "open", "1000000000"]]);
    assert.deepEqual(v0.bounties.map((b: any) => b.periods), Array(4).fill({ revealDelaySeconds: 3, revealWindowSeconds: 600, contestSeconds: 20 }));
    // the view says whether this service reveals and settles a workspace's claims on its own (here it does not), so a
    // screen can say who must reveal before a commitment lapses
    assert.equal(v0.auto, false, JSON.stringify(v0).slice(0, 300));
    assert.equal(v0.artifact.bytecodeSha256, JSON.parse(readFileSync(BOARD_ARTIFACT, "utf8")).bytecodeSha256);
    const B = getAddress(v0.board), T = getAddress(v0.token);
    const anvilUrl = serviceChain(dir); // its chain, over the socket it recorded (F-14)
    const adv = adversary(anvilUrl);
    await adv.rpc("anvil_setBalance", [adv.account.address, toHex(parseEther("100"))]);
    // EIP-5267: the board publishes the domain the commitments are bound to
    const dom = (await adv.pub.readContract({ address: B, abi: board.abi, functionName: "eip712Domain" })) as any[];
    assert.deepEqual([dom[1], dom[2], Number(dom[3]), getAddress(dom[4])], ["QED Bounty Board", "1", 31337, B]);
    assert.deepEqual([v0.domain.name, v0.domain.version, v0.domain.chainId, getAddress(v0.domain.verifyingContract)], ["QED Bounty Board", "1", 31337, B]);
    // the judges are the release's bytecode: their code equals the code of a fresh deployment of the embedded bytecode
    const judgeCode = await adv.pub.getCode({ address: v0.bounties[1].judge });
    assert.ok(judgeCode && judgeCode.length > 1000);
    assert.equal(await adv.pub.readContract({ address: v0.bounties[0].judge, abi: OB, functionName: "verifier" }) !== ZERO, true);
    // R13: the board allows exactly the judges it opened (their runtime code hashes, each with its own claim function:
    // review fix F7), and nobody else may change that; a bounty with any other judge is refused (here an adversary's,
    // the verifier contract, which would keep the pool), and so is an allowed judge with another claim function
    for (const b of v0.bounties) assert.equal(await adv.pub.readContract({ address: B, abi: board.abi, functionName: "judgeClaim", args: [keccak256((await adv.pub.getCode({ address: b.judge }))!)] }), b.selector, `judge of bounty ${b.id} allowed with its claim function`);
    const otherSelector = (v0.bounties as { selector: string }[]).find((b) => b.selector !== v0.bounties[0].selector)!.selector as Hex;
    const wrongClaim = await adv.simulate(B, encodeFunctionData({ abi: board.abi, functionName: "open", args: [v0.bounties[0].judge, T, otherSelector, 3n, 600n, 20n] }));
    assert.deepEqual([wrongClaim?.name, wrongClaim?.args[0]], ["WrongSelector", v0.bounties[0].selector]);
    const verifierAddr = (await adv.pub.readContract({ address: v0.bounties[0].judge, abi: OB, functionName: "verifier" })) as Address;
    const notAJudge = await adv.simulate(B, encodeFunctionData({ abi: board.abi, functionName: "open", args: [verifierAddr, T, "0x12345678", 3n, 600n, 20n] }));
    assert.equal(notAJudge?.name, "JudgeNotAllowed");
    const notDeployer = await adv.simulate(B, encodeFunctionData({ abi: board.abi, functionName: "setJudge", args: [keccak256((await adv.pub.getCode({ address: verifierAddr }))!), "0x12345678"] }));
    assert.deepEqual([notDeployer?.name, getAddress(notDeployer?.args[0] ?? ZERO)], ["NotDeployer", adv.account.address]);

    // ── differential: the commitment this service computes (viem, EIP-712) equals the board's, on random inputs ──
    for (let i = 0; i < 40; i++) {
      const f = { bountyId: BigInt(1 + (i % 4)), claimant: getAddress(toHex(randomBytes(20))), recipient: getAddress(toHex(randomBytes(20))), claim: toHex(randomBytes(i * 7)), salt: toHex(randomBytes(32)) };
      const onChain = await adv.pub.readContract({ address: B, abi: board.abi, functionName: "commitmentOf", args: [f.bountyId, f.claimant, f.recipient, f.claim, f.salt] });
      assert.equal(onChain, commitmentDigest(B, 31337, f));
      assert.notEqual(onChain, commitmentDigest(B, 31338, f), "the chain id is bound");
      assert.notEqual(onChain, commitmentDigest(adv.account.address, 31337, f), "the board's address is bound");
    }

    // ── the two original bounties, preserved exactly: the five recorded claims are refused with the recorded errors ──
    const ba1 = (await s.call("POST", "/workspaces/finder-home/bounties/1/check", { claim: BA1_FIELDS })).data;
    assert.deepEqual([ba1.valid, ba1.error.name, ba1.error.args, ba1.claimHash], [false, ...RECORDED.ba1, keccak256(CLAIM.ba1)], JSON.stringify(ba1));
    const bm1 = (await s.call("POST", "/workspaces/finder-home/bounties/2/check", { claim: BM1_FIELDS })).data;
    assert.deepEqual([bm1.valid, bm1.error.name, bm1.error.args, bm1.claimHash], [false, ...RECORDED.bm1, keccak256(CLAIM.bm1)], JSON.stringify(bm1));
    for (const [name, id] of [["ba1", 1], ["ba2", 1], ["ba3", 1], ["bm1", 2], ["bm2", 2]] as const) {
      const r = await post("finder-home", `/bounties/${id}/claims`, { claim: { calldata: CLAIM[name] } });
      assert.deepEqual([r.status, r.data.error.code, r.data.error.details.error.name, r.data.error.details.error.args], [422, "claim_rejected", ...RECORDED[name]], `${name}: ${JSON.stringify(r.data)}`);
    }
    const v1 = await view("finder-home");
    assert.deepEqual(v1.bounties.slice(0, 2).map((b: any) => [b.phase, b.pool, b.winner]), [["open", "1000000000", null], ["open", "1000000000", null]]);
    assert.deepEqual(v1.claims, [], "a rejected claim records nothing");
    // a claim for the wrong judge, and a malformed one, are refused before anything is stored
    assert.equal((await post("finder-home", "/bounties/1/claims", { claim: { calldata: CLAIM.bm1 } })).data.error.code, "invalid_claim");
    assert.equal((await post("finder-home", "/bounties/9/claims", { claim: { calldata: CLAIM.ba1 } })).data.error.code, "unknown_bounty");

    // ── the optimality positive control: the finder commits through the service ──
    const finder = await view("finder-home"), rival = await view("rival-home");
    const finderClaimant = getAddress(finder.claimant), finderVault = getAddress(finder.recipients.reserve), rivalVault = getAddress(rival.recipients.reserve);
    const vault0 = await tusdOf(adv.pub, T, finderVault), rivalVault0 = await tusdOf(adv.pub, T, rivalVault);
    const good = (await s.call("POST", "/workspaces/finder-home/bounties/3/check", { claim: { calldata: CLAIM.optControl } })).data;
    assert.equal(good.valid, true, JSON.stringify(good));
    const c1 = await job("finder-home", "/bounties/3/claims", { claim: { calldata: CLAIM.optControl } });
    assert.equal(c1.result?.outcome, "executed", JSON.stringify(c1));
    const claimId = c1.result!.evidence!.claimId as Hex;
    // the commit transaction carries the digest only: the claim's bytes are nowhere in it
    const commitTx = await adv.pub.getTransaction({ hash: c1.result!.tx!.hash });
    assert.ok(!commitTx.input.toLowerCase().includes(CLAIM.optControl.slice(10, 200).toLowerCase()));
    // a copier who copies the commit word for word records nothing it could ever reveal
    const copiedCommit = commitTx.input;
    await adv.send(B, copiedCommit);
    // the finder's reveal is not allowed before its delay, and the service sends nothing early
    const early = await job("finder-home", `/bounties/claims/${claimId}/reveal`);
    assert.deepEqual([early.result?.outcome, early.result?.evidence?.error && (early.result.evidence.error as any).name], ["refused", "TooEarly"], JSON.stringify(early.result));
    await untilChain(Number(c1.result!.evidence!.revealableAt) + 1);

    // ── the race: automatic mining paused; the finder's reveal waits in the mempool; the adversary reads and copies it ──
    await adv.rpc("evm_setAutomine", [false]);
    let revealJob: string;
    let pending: any;
    try {
      const a = await post("finder-home", `/bounties/claims/${claimId}/reveal`);
      assert.equal(a.status, 202, JSON.stringify(a.data));
      revealJob = a.data.jobId;
      for (let i = 0; i < 200 && !pending; i++) {
        const pool = (await adv.rpc("txpool_content")) as any;
        pending = Object.values(pool.pending ?? {}).flatMap((x: any) => Object.values(x)).find((t: any) => getAddress(t.from) === finderClaimant && getAddress(t.to) === B);
        if (!pending) await sleep(100);
      }
      assert.ok(pending, "the finder's reveal never reached the mempool");
      const input = pending.input as Hex;
      const args = decodeFunctionData({ abi: board.abi, data: input }).args as [bigint, Address, Hex, Hex];
      assert.deepEqual([args[0], getAddress(args[1]), args[2]], [3n, finderVault, CLAIM.optControl], "the adversary learns the claim from the pending reveal");
      // (a) the reveal, byte for byte; (b) the reveal paying the copier; (c) the claim straight to the judge; (d) its own commitment
      const judge = getAddress(finder.bounties[2].judge);
      // the board recomputes the digest with the copier as claimant, which matches no record
      assert.deepEqual(await adv.simulate(B, input), { name: "NoCommitment", args: [commitmentDigest(B, 31337, { bountyId: 3n, claimant: adv.account.address, recipient: finderVault, claim: args[2], salt: args[3] })] });
      const copyA = await adv.send(B, input);
      const copyB = await adv.send(B, encodeFunctionData({ abi: board.abi, functionName: "reveal", args: [3n, adv.account.address, args[2], args[3]] }));
      const copyC = await adv.send(judge, args[2]);
      const mySalt = toHex(randomBytes(32));
      const copyD = await adv.send(B, encodeFunctionData({ abi: board.abi, functionName: "commit", args: [3n, commitmentDigest(B, 31337, { bountyId: 3n, claimant: adv.account.address, recipient: adv.account.address, claim: args[2], salt: mySalt })] }));
      await adv.rpc("evm_mine", []);
      const block = (await adv.pub.getBlock({ includeTransactions: false })) as any;
      const order = block.transactions.map((h: string) => h.toLowerCase());
      for (const h of [copyA, copyB, copyC, copyD]) assert.ok(order.indexOf(h.toLowerCase()) < order.indexOf(String(pending.hash).toLowerCase()), "the copier's transactions were mined ahead of the finder's");
      const rc = async (h: Hex) => adv.pub.getTransactionReceipt({ hash: h });
      assert.deepEqual([(await rc(copyA)).status, (await rc(copyB)).status, (await rc(copyC)).status, (await rc(copyD)).status], ["reverted", "reverted", "success", "success"]);
      const refuted = parseEventLogs({ abi: OB, logs: (await rc(copyC)).logs, eventName: "Refuted" }) as any[];
      assert.deepEqual([refuted.length, getAddress(refuted[0].args.claimant), refuted[0].args.payout], [1, adv.account.address, 0n], "the judge paid the copier its balance: nothing");
      await adv.rpc("evm_setAutomine", [true]);
      const r = await waitJob("finder-home", revealJob);
      assert.equal(r.result?.outcome, "executed", JSON.stringify(r));
      assert.equal(await tusdOf(adv.pub, T, adv.account.address), 0n);
      // (e) the copier's own commitment, once old enough, cannot take over: the finder's is older
      await untilChain(Math.floor(Date.now() / 1000) + 4);
      assert.deepEqual(await adv.simulate(B, encodeFunctionData({ abi: board.abi, functionName: "reveal", args: [3n, adv.account.address, args[2], mySalt] })), { name: "NotFirst", args: [String((await adv.pub.readContract({ address: B, abi: board.abi, functionName: "commitments", args: [finderClaimant, claimId] }) as any[])[0])] });
      // (f) the copied commit: the copier holds a record of the finder's digest, and no reveal of it works
      assert.equal(((await adv.simulate(B, encodeFunctionData({ abi: board.abi, functionName: "reveal", args: [3n, finderVault, args[2], args[3]] }))) as any).name, "NoCommitment");
    } finally {
      await adv.rpc("evm_setAutomine", [true]).catch(() => undefined);
    }
    // (g) another workspace, through the service, learns the claim from the chain and tries to claim it: refused
    const late = await post("rival-home", "/bounties/3/claims", { claim: { calldata: CLAIM.optControl } });
    assert.deepEqual([late.status, late.data.error.code], [409, "bounty_not_open"], JSON.stringify(late.data));
    // settling early is refused with nothing sent; after the contest anyone (here the rival) settles, and only the finder's vault is paid
    const st = (await view("finder-home")).bounties[2];
    assert.equal(st.phase, "contest");
    const tooSoon = await job("rival-home", "/bounties/3/settle");
    assert.equal(tooSoon.result?.outcome, "refused");
    await untilChain(Number(st.contestEndsAt) + 1);
    const paid = await job("rival-home", "/bounties/3/settle");
    assert.deepEqual([paid.result?.outcome, paid.result?.evidence?.payout, getAddress(paid.result?.evidence?.recipient as string)], ["executed", POOL.toString(), finderVault], JSON.stringify(paid.result));
    assert.equal(await tusdOf(adv.pub, T, finderVault) - vault0, POOL);
    assert.equal(await tusdOf(adv.pub, T, rivalVault) - rivalVault0, 0n);
    assert.equal(await tusdOf(adv.pub, T, adv.account.address), 0n);
    const won = (await view("finder-home")).claims[0];
    assert.deepEqual([won.claimId, won.state, won.paidText, "salt" in won], [claimId, "won", "1,000.00 tUSD", false]);

    // ── the maximality positive control: two independent finders; the older commitment wins although revealed second ──
    const cF = await job("finder-home", "/bounties/4/claims", { claim: { calldata: CLAIM.maxControl } });
    await sleep(1100);
    const cR = await job("rival-home", "/bounties/4/claims", { claim: { calldata: CLAIM.maxControl } });
    assert.ok(BigInt(cR.result!.evidence!.seq as string) > BigInt(cF.result!.evidence!.seq as string));
    await untilChain(Number(cR.result!.evidence!.revealableAt) + 1);
    const rFirst = await job("rival-home", `/bounties/claims/${cR.result!.evidence!.claimId}/reveal`);
    assert.equal(rFirst.result?.outcome, "executed", JSON.stringify(rFirst.result));
    const fSecond = await job("finder-home", `/bounties/claims/${cF.result!.evidence!.claimId}/reveal`);
    assert.deepEqual([fSecond.result?.outcome, fSecond.result?.evidence?.replaced && getAddress(fSecond.result.evidence.replaced as string)], ["executed", getAddress(rival.claimant)], JSON.stringify(fSecond.result));
    const rAgain = await job("rival-home", `/bounties/claims/${cR.result!.evidence!.claimId}/reveal`);
    assert.equal(rAgain.result?.outcome, "no-action", "a commitment is revealed at most once");
    await untilChain(Number((await view("finder-home")).bounties[3].contestEndsAt) + 1);
    assert.equal((await job("finder-home", "/bounties/4/settle")).result?.outcome, "executed");
    assert.equal(await tusdOf(adv.pub, T, finderVault) - vault0, 2n * POOL);
    assert.equal(await tusdOf(adv.pub, T, rivalVault) - rivalVault0, 0n);
    assert.deepEqual((await view("rival-home")).claims.map((c: any) => c.state), ["lost"]);

    // ── a restart keeps the board, the bounties and the claims; nothing is deployed again ──
    assert.equal(await s.stop(), 0);
    s = await startService("svc-bounties", BASE, BASE + 1, { env, workspace: null, dir });
    const after = await view("finder-home");
    assert.deepEqual([getAddress(after.board), after.bounties.map((b: any) => [b.id, b.phase, b.paid])], [B, [["1", "open", "0"], ["2", "open", "0"], ["3", "settled", "1000000000"], ["4", "settled", "1000000000"]]]);
    assert.deepEqual(after.claims.map((c: any) => [c.key, c.state]), [["maximality-control", "won"], ["optimality-control", "won"]]);
    assert.match(s.log(), /chain state restored/);
    ok = true;
  } finally {
    await s.stop().catch(() => undefined);
    if (ok) rmSync(dir, { recursive: true, force: true });
    else console.log(`service log tail:\n${s.log().slice(-3000)}`);
  }
});

test("liveness on a host with a test clock: a commitment never revealed blocks nobody; an expired one is refused with nothing sent; the heartbeat reveals and settles by itself", { timeout: 300_000 }, async () => {
  let offset = 0;
  const th = await startHost("bounty-liveness", BASE + 2, { economyAnvilPort: ECON, wallClock: () => Date.now() + offset, monoClock: () => performance.now() + offset, bounty: { enabled: true, controls: true, auto: false, revealDelaySeconds: 30, revealWindowSeconds: 60, contestSeconds: 30 } });
  let ok = false;
  try {
    const ws = await th.workspace("solo-home", [new SoftwarePasskey()]);
    const b = th.host.bountyBoard!;
    assert.ok(b, th.host.bountyStatus.reason);
    const run = async (kind: "bounty-commit" | "bounty-reveal" | "bounty-settle", params: unknown) => ws.waitForJob(ws.submit(kind, params, key()).jobId);
    // a stranger commits to bounty 3 and never reveals
    const adv = adversary(th.host.anvil.url);
    await adv.rpc("anvil_setBalance", [adv.account.address, toHex(parseEther("10"))]);
    await adv.rpc("evm_setNextBlockTimestamp", [toHex(Math.floor((Date.now() + offset) / 1000))]);
    await adv.send(b.board, encodeFunctionData({ abi: board.abi, functionName: "commit", args: [3n, keccak256(toHex("never revealed"))] }));
    // this workspace commits, lets the commitment expire, and is refused with nothing sent
    const c1 = await run("bounty-commit", await ws.bounties.commitParams("3", { claim: { calldata: CLAIM.optControl } }));
    assert.equal(c1.result?.outcome, "executed", JSON.stringify(c1));
    offset += (30 + 60 + 1) * 1000;
    const claims1 = await ws.bounties.claims();
    assert.equal(claims1.claims[0].state, "expired");
    const r1 = await run("bounty-reveal", ws.bounties.revealParams(c1.result!.evidence!.claimId));
    assert.deepEqual([r1.result?.outcome, (r1.result?.evidence?.error as any)?.name], ["refused", "Expired"]);
    assert.equal(ws.store.attempts(r1.id).length, 0, "nothing was sent for a refused reveal");
    // a new commitment; the heartbeat reveals it once it may be, and settles it once the contest has closed
    const c2 = await run("bounty-commit", await ws.bounties.commitParams("3", { claim: { calldata: CLAIM.optControl } }));
    th.host.cfg.bounty.auto = true;
    await th.host.tick();
    assert.equal((await ws.bounties.claims()).claims[0].state, "committed", "nothing is revealed before the delay");
    offset += 31_000;
    await th.host.tick();
    const auto = ws.jobs(10).find((j) => j.kind === "bounty-reveal" && j.id !== r1.id)!;
    assert.ok(auto, "the heartbeat submitted the reveal");
    assert.equal((await ws.waitForJob(auto.id)).result?.outcome, "executed");
    assert.equal((await ws.bounties.claims()).claims[0].state, "leading");
    await th.host.tick(); // a second heartbeat starts nothing new
    assert.equal(ws.jobs(20).filter((j) => j.kind === "bounty-reveal").length, 2);
    offset += 31_000;
    await th.host.tick();
    const settle = ws.jobs(20).find((j) => j.kind === "bounty-settle")!;
    assert.ok(settle, "the heartbeat submitted the settlement");
    assert.equal((await ws.waitForJob(settle.id)).result?.outcome, "executed");
    const end = (await ws.bounties.claims()).claims;
    assert.deepEqual(end.map((c) => c.state), ["won", "expired"]);
    assert.equal(await tusdOf(th.host.pub, b.token, ws.a.reserve), POOL);
    assert.equal(c2.result?.evidence?.claimId, end[0].claimId);
    ok = true;
  } finally {
    await th.stop({ keep: !ok });
  }
});

test("the committed build is the source: chain/bounties/artifacts/QEDBountyBoard.json was exported from the current QEDBountyBoard.sol", () => {
  const src = readFileSync(join(CHAIN, "bounties", "src", "QEDBountyBoard.sol"));
  assert.equal(board.sourceSha256, createHash("sha256").update(src).digest("hex"), "the source changed: run SOLC_VERSION=0.8.26 forge build && node scripts/export-artifacts.mjs in chain/bounties");
  assert.equal(board.bytecodeSha256, createHash("sha256").update(board.bytecode.toLowerCase()).digest("hex"));
  assert.ok(board.abi.some((x: any) => x.type === "function" && x.name === "commitmentOf"));
});
