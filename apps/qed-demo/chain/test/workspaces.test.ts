/**
 * R7 workspaces (D1, D3, D4) on one shared chain: two workspaces owned by two different software passkeys.
 *
 *   - provisioning as amended on 22 Nov 2026: the vault set is configured by the workspace's deployer key while it
 *     holds nothing, the passkey account accepts it, the grant arrives only after that, and the deployer can then do
 *     nothing on any of the contracts;
 *   - owner actions need a valid passkey assertion, checked on chain, and no key the service holds can perform one;
 *   - two workspaces cannot read or move each other's funds, and one paused or depleted leaves the other working;
 *   - guarded calls never run through execute; they are scheduled, listed, cancellable and applied after the delay;
 *   - a restart restores every workspace's state.
 */
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { encodeFunctionData, getAddress, hashMessage, toFunctionSelector, type Address, type Hex } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { key, startHost, type TestHost } from "./helpers.ts";
import { SoftwarePasskey, passkeyApproval } from "./passkey.ts";
import { encodeAssertions, toContractAssertion } from "../rail/webauthn.ts";
import { releaseGuards } from "../accounts/webauthn.ts";
import type { Rail } from "../rail/host.ts";
import type { ToSign } from "../types.ts";

process.env.PATH = `${join(homedir(), ".foundry", "bin")}:${process.env.PATH}`;
const alice = new SoftwarePasskey(), bob = new SoftwarePasskey(), mallory = new SoftwarePasskey();
let h: TestHost, A: Rail, B: Rail;
const ACCOUNT_ABI = JSON.parse(readFileSync(join(import.meta.dirname, "..", "accounts", "out", "QEDOwnerAccount.sol", "QEDOwnerAccount.json"), "utf8")).abi;
const rejects = async (f: () => Promise<unknown>, code: string) => assert.rejects(f, (e: { code?: string; message?: string }) => { assert.equal(e.code, code, e.message); return true; });
const bal = (ws: Rail, token: Address, who: Address) => ws.read(token, ws.v.abi.TestUSDAbi, "balanceOf", [who]) as Promise<bigint>;
const owner = async (ws: Rail, v: Address) => getAddress((await ws.read(v, ws.v.abi.QEDVaultAbi, "owner")) as Address);

before(async () => {
  h = await startHost("workspaces", 18745);
  A = await h.workspace("alice-home", [alice]);
  B = await h.workspace("bob-shop", [bob]);
});
after(async () => { await h?.stop(); });

test("provisioning: configured by a deployer key while empty, accepted by the passkey account; nothing arrives before; afterwards the deployer can do nothing", async () => {
  const s0 = await A.state();
  const dep = A.K.DEPLOYER.address, acct = A.a.ownerAccount!;
  assert.equal(A.summary.status, "awaiting-acceptance");
  assert.deepEqual([s0.treasury.balance, s0.reserve.balance, (await bal(A, A.a.asset!, acct)).toString()], ["0", "0", "0"], "no funds before acceptance");
  assert.equal(A.summary.grant, null);
  assert.deepEqual([await owner(A, A.a.vault), await owner(A, A.a.reserve)], [dep, dep], "the deployer is the temporary owner of an empty vault set");
  for (const v of [A.a.vault, A.a.reserve]) assert.equal(getAddress((await A.read(v, A.v.abi.QEDVaultAbi, "pendingOwner")) as Address), acct);
  assert.equal(getAddress(s0.treasury.agent), A.a.exec, "configured before acceptance: QEDExecution is the agent");
  assert.ok(!/^0x0+$/.test((await A.read(A.a.exec, A.v.abi.QEDExecutionAbi, "venueSetHash")) as string), "venues named before acceptance");
  // the account's guards are exactly what chain/accounts builds from those addresses
  const want = [...releaseGuards({ vault: A.a.vault, execution: A.a.exec, policy: A.a.treasuryPolicy! }), ...releaseGuards({ vault: A.a.reserve })];
  assert.deepEqual(A.summary.guards.map((g) => [getAddress(g.target), g.selector]), want.map((g) => [getAddress(g.target), g.selector]));
  await rejects(() => A.propose({ kind: "mandate", params: { maxPerPayment: "100" } }), "not_provisioned");

  const job = await h.act(A, "provision", {}, [alice]);
  assert.equal(job.result?.outcome, "executed", job.error ?? "");
  assert.deepEqual([await owner(A, A.a.vault), await owner(A, A.a.reserve)], [acct, acct]);
  const grant = A.summary.grant!;
  assert.equal((await bal(A, A.a.asset!, A.a.vault)).toString(), grant.vault);
  assert.equal((await bal(A, A.a.asset!, acct)).toString(), grant.ownerAccount);
  const accepted = BigInt(job.result!.tx!.block);
  for (const t of grant.txs) assert.ok((await A.pub.getTransactionReceipt({ hash: t })).blockNumber > accepted, "the grant is minted after the acceptance block");

  // the deployer key, and every other key the service holds, can do nothing on any of the contracts any more
  const A_ = A.v.abi, data = (abi: unknown, fn: string, args: unknown[] = []) => encodeFunctionData({ abi: abi as never, functionName: fn, args } as never);
  const attempts: [Address, Hex, string[]][] = [
    [A.a.vault, data(A_.QEDVaultAbi, "setAgent", [dep]), ["NotOwner"]], [A.a.vault, data(A_.QEDVaultAbi, "setCosigner", [dep]), ["NotOwner"]],
    [A.a.vault, data(A_.QEDVaultAbi, "setGuardian", [dep]), ["NotOwner"]], [A.a.vault, data(A_.QEDVaultAbi, "setDailyCap", [1n]), ["NotOwner"]],
    [A.a.vault, data(A_.QEDVaultAbi, "transferOwnership", [dep]), ["NotOwner"]], [A.a.vault, data(A_.QEDVaultAbi, "withdraw", [dep, 1n]), ["NotOwner"]],
    [A.a.vault, data(A_.QEDVaultAbi, "unpause"), ["NotOwner"]], [A.a.vault, data(A_.QEDVaultAbi, "bumpEpoch"), ["NotOwner"]], [A.a.vault, data(A_.QEDVaultAbi, "acceptOwnership"), ["NotPendingOwner"]],
    [A.a.reserve, data(A_.QEDVaultAbi, "withdraw", [dep, 1n]), ["NotOwner"]], [A.a.reserve, data(A_.QEDVaultAbi, "setAgent", [dep]), ["NotOwner"]],
    [A.a.exec, data(A_.QEDExecutionAbi, "setVenues", [[], []]), ["NotVaultOwner"]], [A.a.exec, data(A_.QEDExecutionAbi, "setOperator", [dep]), ["NotVaultOwner"]],
    [A.a.treasuryPolicy!, data(A_.QEDTreasuryPolicyAbi, "setAgent", [dep]), ["NotOwner"]], [A.a.treasuryPolicy!, data(A_.QEDTreasuryPolicyAbi, "revoke"), ["NotOwner"]],
  ];
  const held = [A.K.DEPLOYER, A.K.OPERATOR, A.K.GUARDIAN, A.relayer!, A.K.LP1, A.K.MALLORY, A.K.CLOUDCO, B.K.DEPLOYER, B.relayer!];
  for (const k of held) for (const [to, d, names] of attempts) {
    const err = await A.c.simulateError(k.address, to, d);
    assert.ok(err && names.includes(err.name), `${k.address} → ${to} ${d.slice(0, 10)}: ${err?.name}`);
  }
  assert.equal((await h.act(B, "provision", {}, [bob])).result?.outcome, "executed");
});

test("owner actions need a valid passkey assertion: missing, foreign, tampered, wrong challenge, no user verification; each refused on chain before anything is stored", async () => {
  const p = await A.propose({ kind: "pause", params: {} });
  const toSign = p.terms.toSign as ToSign[];
  assert.equal(toSign.length, 1);
  assert.equal(toSign[0].kind, "execute");
  const digest = toSign[0].digest;
  const e = toSign[0] as Extract<ToSign, { kind: "execute" }>;
  assert.equal(digest, await A.read(A.a.ownerAccount!, ACCOUNT_ABI, "executeDigest", [e.calls.map((c) => ({ target: c.target, value: 0n, data: c.data })), BigInt(e.nonce), BigInt(e.deadline)]), "the digest is the account's own executeDigest");
  const sign = (k: SoftwarePasskey, o: Parameters<SoftwarePasskey["assert"]>[1] = {}, d = digest) => passkeyApproval(p, [], A.now(), { signatures: [{ assertions: [k.assert(d, o)] }] });
  const cases: [string, unknown, string][] = [
    ["no signatures", passkeyApproval(p, [], A.now(), { signatures: undefined }), "approval_signature_missing"],
    ["bob is not a member", sign(bob), "approval_signature_invalid"],
    ["mallory is unknown", sign(mallory), "approval_signature_invalid"],
    ["another origin", sign(alice, { origin: "http://evil.example" }), "approval_signature_invalid"],
    ["another relying party", sign(alice, { rpId: "evil.example" }), "approval_signature_invalid"],
    ["no user verification", sign(alice, { flags: 0x01 }), "approval_signature_invalid"],
    ["a registration ceremony", sign(alice, { type: "webauthn.create" }), "approval_signature_malformed"],
    ["another challenge", sign(alice, {}, `0x${"ab".repeat(32)}`), "approval_signature_mismatch"],
  ];
  const tampered = sign(alice) as any;
  const sig = tampered.signatures[0].assertions[0].signature as string;
  tampered.signatures[0].assertions[0].signature = sig.slice(0, -2) + (sig.endsWith("00") ? "01" : "00");
  cases.push(["a tampered signature", tampered, "approval_signature_invalid"]);
  for (const [what, approval, code] of cases) {
    const k = key();
    await rejects(() => A.executeChecked(p.id, approval, k), code);
    assert.throws(() => A.submission(k), (e: { code: string }) => e.code === "unknown_submission", `${what}: nothing stored, the key stays free`);
  }
  assert.equal((await A.state()).treasury.paused, false, "nothing was sent");
  const refused = A.decisions(50).filter((d) => d.kind === "approval-refused").map((d) => (d.record as { code: string }).code);
  for (const [, , code] of cases) assert.ok(refused.includes(code), `the refusal ${code} is recorded`);
  const ok = await A.executeChecked(p.id, passkeyApproval(p, [alice], A.now()), key());
  assert.equal((await A.waitForJob(ok.jobId)).result?.outcome, "executed");
  assert.equal((await A.state()).treasury.paused, true);
  // the same signatures on the next owner action are for another digest (the account's nonce moved on)
  const r = await A.propose({ kind: "resume", params: {} });
  await rejects(() => A.executeChecked(r.id, passkeyApproval(p, [alice], A.now(), { termsHash: r.termsHash, signatures: (passkeyApproval(p, [alice], A.now()).signatures) }), key()), "approval_signature_mismatch");
  assert.equal((await h.act(A, "resume", {}, [alice])).result?.outcome, "executed");
});

test("no key the service holds can sign for the owner account (ERC-1271) or is one of its signers", async () => {
  const acct = A.a.ownerAccount!, abi = ACCOUNT_ABI;
  const hash = hashMessage("QED test: any owner statement");
  const held = [A.K.DEPLOYER, A.K.OPERATOR, A.K.GUARDIAN, A.relayer!, A.K.LP1, A.K.MALLORY, A.K.CLOUDCO, privateKeyToAccount(generatePrivateKey())];
  for (const k of held) {
    const sig = await k.signMessage({ message: "QED test: any owner statement" });
    assert.equal(await A.read(acct, abi, "isValidSignature", [hash, sig]), "0xffffffff", `${k.address} cannot sign as the owner`);
  }
  const ids = (await A.read(acct, abi, "signerIds")) as Hex[];
  assert.deepEqual(ids, [toContractAssertion(alice.assert(`0x${"00".repeat(32)}`)).signerId], "the only signer is alice's passkey");
  // the host keeps public keys only: nothing in the registry or the workspace's records is a private key
  const spec = JSON.stringify(h.host.store.workspace("alice-home"));
  assert.ok(spec.includes(alice.publicKey.x.slice(2)) && !/"d"\s*:/.test(spec));
  // a passkey assertion is the only thing the account accepts, and only from its member
  const ok = encodeAssertions([toContractAssertion(alice.assert((await A.read(acct, abi, "replaySafeHash", [hash])) as Hex))]);
  assert.equal(await A.read(acct, abi, "isValidSignature", [hash, ok]), "0x1626ba7e");
  const bad = encodeAssertions([toContractAssertion(bob.assert((await A.read(acct, abi, "replaySafeHash", [hash])) as Hex))]);
  assert.equal(await A.read(acct, abi, "isValidSignature", [hash, bad]), "0xffffffff");
});

test("two workspaces cannot read or move each other's funds, and the forked co-signer certifies for a passkey owner where the release's cannot", async () => {
  for (const [ws, k] of [[A, alice], [B, bob]] as const) assert.equal((await h.act(ws, "mandate", { maxPerPayment: "2500" }, [k])).result?.outcome, "executed");
  // R7 D7: an 840 tINR conversion may cost up to about 14 tINR against the reference (its worst case), more than the 10 tINR base; the owner grants authority (no money moves)
  assert.equal((await h.act(A, "grant", { amount: "100" }, [alice])).result?.outcome, "executed");
  const pay = await h.act(A, "pay", { payee: "CloudCo", amount: "3.5" }, [alice]);
  assert.equal(pay.result?.outcome, "executed", pay.error ?? "");
  const conv = await h.act(A, "convert", { amount: "840" }, [alice]);
  assert.equal(conv.result?.outcome, "executed", conv.error ?? "");
  assert.equal(conv.steps.find((s) => s.key === "cosigner")!.data!.engine, "fork");
  const bBefore = await B.state();
  // identifiers of A find nothing in B
  const aProposal = A.store.db.prepare("SELECT id FROM proposals LIMIT 1").get() as { id: string };
  const aKey = (A.store.db.prepare("SELECT key FROM submissions LIMIT 1").get() as { key: string }).key;
  assert.throws(() => B.proposal(aProposal.id), (e: { code: string }) => e.code === "unknown_proposal");
  assert.throws(() => B.job(conv.id), (e: { code: string }) => e.code === "unknown_job");
  assert.throws(() => B.submission(aKey), (e: { code: string }) => e.code === "unknown_submission");
  await rejects(() => B.receipt(conv.result!.tx!.hash), "unknown_receipt");
  assert.deepEqual(B.decisions(50, conv.id), []);
  const aProp = A.proposal(aProposal.id);
  await rejects(() => B.executeChecked(aProposal.id, passkeyApproval(aProp, [bob], B.now()), key()), "unknown_proposal");
  // B's owner cannot sign A's action, and A's valid approval does not fit B's proposal
  const ap = await A.propose({ kind: "withdraw", params: { amount: "1" } });
  await rejects(() => A.executeChecked(ap.id, passkeyApproval(ap, [bob], A.now()), key()), "approval_signature_invalid");
  const bp = await B.propose({ kind: "withdraw", params: { amount: "1" } });
  await rejects(() => B.executeChecked(bp.id, passkeyApproval(ap, [alice], B.now(), { termsHash: bp.termsHash }), key()), "approval_signature_mismatch");
  assert.equal((await A.waitForJob((await A.executeChecked(ap.id, passkeyApproval(ap, [alice], A.now()), key())).jobId)).result?.outcome, "executed");
  // a withdrawal moves only the workspace's own funds, to its own account
  const bVault0 = await bal(B, B.a.asset!, B.a.vault), bAcct0 = await bal(B, B.a.asset!, B.a.ownerAccount!), aVault0 = await bal(A, A.a.asset!, A.a.vault), aAcct0 = await bal(A, A.a.asset!, A.a.ownerAccount!);
  assert.equal((await h.act(B, "withdraw", { amount: "250.75" }, [bob])).result?.outcome, "executed");
  assert.equal(bVault0 - (await bal(B, B.a.asset!, B.a.vault)), 25075n);
  assert.equal((await bal(B, B.a.asset!, B.a.ownerAccount!)) - bAcct0, 25075n);
  // the state reports what the owner account itself holds, where the withdrawal landed (RISK-072)
  assert.equal((await B.state()).ownerHolds.asset, String(await bal(B, B.a.asset!, B.a.ownerAccount!)));
  assert.equal(BigInt((await B.state()).ownerHolds.asset) - bAcct0, 25075n);
  assert.deepEqual([await bal(A, A.a.asset!, A.a.vault), await bal(A, A.a.asset!, A.a.ownerAccount!)], [aVault0, aAcct0], "B's withdrawal did not touch A's vault or A's account");
  assert.notEqual(A.a.vault, B.a.vault);
  assert.notEqual(A.K.OPERATOR.address, B.K.OPERATOR.address, "each workspace has its own agent key");
  assert.equal((await B.state()).reserve.balance, bBefore.reserve.balance, "A's conversion did not touch B's reserve");
  // the release's unmodified engine cannot verify a passkey owner (C1, C3); the fork does, as the vault does
  const am = A.activeMandate()!;
  const cp = await A.propose({ kind: "convert", params: { amount: "84" } });
  const { signature } = await A.owner.signMessage(cp.terms as never, passkeyApproval(cp, [alice], A.now()), { notBeforeMs: Date.parse(cp.createdAt), notAfterMs: Date.parse(cp.expiresAt), nowMs: A.now() });
  const req = { mandate: am.mandate, ownerSig: am.ownerSig, module: A.a.exec, tokenIn: A.a.asset, tokenOut: A.a.reserveAsset, recipient: A.a.reserve, amountIn: 8400n, instruction: "Convert 84 tINR", nonce: (cp.terms as any).nonce, instructionSig: signature, brainEngine: "test" };
  const chain = new A.v.chain.Chain$(A.anvil.url, 31337);
  const cfg = { vault: A.a.vault, lens: A.a.lens, escrow: A.a.vault, owner: A.a.ownerAccount, vendorKeys: {}, catalogPrices: {}, denylist: [], deployBlock: BigInt(A.a.deployBlock), recordsDir: join(h.dir, "diff-records") };
  const keyAcct = privateKeyToAccount(generatePrivateKey());
  // The release's engine recovers an ECDSA signer from the owner's signature; an ERC-1271 signature is not one, its
  // fallback "0x0" is not an address, and the engine throws before deciding anything (vendor/agent/src/roles/cosigner.ts:246-247).
  await assert.rejects(() => new A.v.cosigner.PolicyEngine(chain, keyAcct, cfg as never).evaluateTrade(req as never), /Address "0x0" is invalid/);
  const { createForkedPolicyEngine } = await import("../rail/cosigner-engine.ts");
  const fork = await new (createForkedPolicyEngine(A.v))(chain as never, keyAcct, cfg as never).evaluateTrade(req as never);
  const pass = (r: any, id: string) => r.checks.find((c: any) => c.id === id).pass;
  assert.deepEqual([pass(fork, "C1"), pass(fork, "C3")], [true, true], "the fork asks the owner account (ERC-1271), as the vault does");
  assert.match(fork.checks.find((c: any) => c.id === "C10")!.detail, /≥ 5\.00/, "the reserve buffer is 5 tINR, written in tINR");
});

test("one workspace paused or depleted while the other keeps working", async () => {
  assert.equal((await h.act(A, "pause", {}, [alice])).result?.outcome, "executed");
  const p = await A.propose({ kind: "pay", params: { payee: "CloudCo", amount: "1" } });
  assert.equal(p.checks.find((c) => c.id === "not-paused")!.pass, false, "A's own limits say it is paused");
  assert.equal((await h.act(B, "convert", { amount: "420" }, [bob])).result?.outcome, "executed", "B converts while A is paused");
  assert.equal((await h.act(A, "resume", {}, [alice])).result?.outcome, "executed");
  const free = BigInt((await A.state()).treasury.free);
  const w = await h.act(A, "withdraw", { amount: A.fmt(free).replace(/,/g, "") }, [alice]);
  assert.equal(w.result?.outcome, "executed", w.error ?? "");
  assert.equal((await A.state()).treasury.free, "0", "A is depleted");
  assert.equal((await A.propose({ kind: "convert", params: { amount: "10" } })).allowed, false);
  assert.equal((await h.act(B, "convert", { amount: "210" }, [bob])).result?.outcome, "executed", "B keeps working");
  assert.equal((await h.act(B, "deposit", { amount: "100" }, [bob])).result?.outcome, "executed");
});

test("a restart restores every workspace's state", async () => {
  const snap = async (ws: Rail) => { const s = await ws.state(); return { treasury: [s.treasury.balance, s.treasury.free, s.treasury.paused], reserve: s.reserve.balance, mandate: s.mandate?.hash, jobs: ws.jobs(200).map((j) => [j.id, j.status, j.result?.outcome ?? null]), history: ws.history(200).length, decisions: ws.verifyDecisions(), owner: s.roles.owner, summary: ws.summary.status, authority: await ws.cosigner.authority() }; };
  const before = { a: await snap(A), b: await snap(B) };
  await h.host.stop();
  const again = await startHost("workspaces", 18745, { dataDir: h.dir });
  h = again;
  A = again.host.workspace("alice-home")!;
  B = again.host.workspace("bob-shop")!;
  assert.deepEqual({ a: await snap(A), b: await snap(B) }, before);
  assert.equal(again.host.restoredFromState, true);
  assert.equal((await again.act(A, "deposit", { amount: "5" }, [alice])).result?.outcome, "executed", "A works after the restart");
  assert.equal((await again.act(B, "pause", {}, [bob])).result?.outcome, "executed", "B works after the restart");
});

test("guarded calls: never through execute (GuardedCall); a rotation is scheduled, listed, cancelled by one member, refused before the delay and applied after it", async () => {
  let offset = 0;
  const t = await startHost("workspaces-scheduled", 18747, { wallClock: () => Date.now() + offset, heartbeatMs: 3_600_000 });
  try {
    const carol = new SoftwarePasskey(), dave = new SoftwarePasskey();
    const C = await t.workspace("carol-family", [carol, dave], 1);
    assert.equal((await t.act(C, "provision", {}, [carol])).result?.outcome, "executed");
    const acct = C.a.ownerAccount!, abi = ACCOUNT_ABI;
    // a guarded call sent through execute, signed by every member, reverts with GuardedCall
    const calls = [{ target: C.a.vault, value: 0n, data: encodeFunctionData({ abi: C.v.abi.QEDVaultAbi, functionName: "setAgent", args: [C.K.OPERATOR.address] }) }];
    const nonce = (await C.read(acct, abi, "nonce")) as bigint, deadline = BigInt(Math.floor(Date.now() / 1000) + 600);
    const digest = (await C.read(acct, abi, "executeDigest", [calls, nonce, deadline])) as Hex;
    const both = [carol, dave].map((k) => toContractAssertion(k.assert(digest))).sort((x, y) => (BigInt(x.signerId) < BigInt(y.signerId) ? -1 : 1));
    const err = await C.c.simulateError(C.relayer!.address, acct, encodeFunctionData({ abi, functionName: "execute", args: [calls, nonce, deadline, both] }));
    assert.equal(err?.selector, toFunctionSelector("GuardedCall(uint256,address,bytes4)"));
    // the rail schedules a rotation of the operator key instead
    const old = C.K.OPERATOR.address;
    const s1 = await t.act(C, "rotate-key", { role: "operator" }, [dave]);
    assert.equal(s1.result?.outcome, "scheduled", s1.error ?? "");
    let list = await C.scheduled();
    assert.equal(list.length, 1);
    assert.deepEqual([list[0].kind, list[0].status, list[0].ready], ["rotate-key", "pending", false]);
    assert.equal(getAddress((await C.read(C.a.exec, C.v.abi.QEDExecutionAbi, "operator")) as Address), old, "nothing changed yet");
    const cancelled = await t.act(C, "cancel-change", { changeId: list[0].changeId }, [carol]);
    assert.equal(cancelled.result?.outcome, "executed", cancelled.error ?? "");
    assert.equal(((await C.read(acct, abi, "getChange", [list[0].changeId])) as { readyAt: bigint }).readyAt, 0n, "the account dropped it");
    assert.equal((await C.scheduled())[0].status, "cancelled");
    const s2 = await t.act(C, "rotate-key", { role: "operator" }, [carol]);
    assert.equal(s2.result?.outcome, "scheduled");
    list = await C.scheduled();
    const pending = list.find((x) => x.status === "pending")!;
    const early = await C.waitForJob(C.submit("apply-change", C.applyParams(pending.changeId), key()).jobId);
    assert.equal(early.result?.outcome, "refused", "not before the delay");
    offset += 61_000; // the wall clock moves on (an injected clock, as the liabilities test does); the chain follows it forward
    const applied = await C.waitForJob(C.submit("apply-change", C.applyParams(pending.changeId), key()).jobId);
    assert.equal(applied.result?.outcome, "executed", applied.error ?? "");
    const now = getAddress((await C.read(C.a.exec, C.v.abi.QEDExecutionAbi, "operator")) as Address);
    assert.notEqual(now, old);
    assert.equal(now, C.K.OPERATOR.address, "the rail uses the new agent key from now on");
    assert.equal((await C.scheduled()).find((x) => x.changeId === pending.changeId)!.status, "applied");
  } finally { await t.stop(); }
});

test("a standing policy signed by the passkey (ERC-1271) is registered with the shared co-signer and its ticks convert to the target; contract enforcement waits behind the delay", async () => {
  const erin = new SoftwarePasskey();
  const E = await h.workspace("erin-saves", [erin]);
  // R7 D7: a tranche of about 1,680 tINR may cost up to about 27 tINR against the reference (its worst case); the owner grants authority first (no money moves)
  for (const [k, p] of [["provision", {}], ["mandate", { maxPerPayment: "2500" }], ["grant", { amount: "100" }], ["policy", { targetFree: "20" }]] as const) assert.equal((await h.act(E, k, p, [erin])).result?.outcome, "executed", k);
  const run = await E.waitForJob(E.submit("policy-run", { maxTicks: 4, maxSeconds: 60 }, key()).jobId);
  assert.equal(run.result?.outcome, "executed", run.error ?? "");
  const ev = run.result!.evidence as { stopReason: string; targetMet: boolean; ticks: { action: string }[] };
  assert.deepEqual([ev.targetMet, ev.stopReason, ev.ticks.map((t) => t.action)], [true, "the target is met", ["convert", "none"]]);
  assert.ok(BigInt((await E.state()).reserve.free) >= 20_000_000n, "20 tUSD free in the dollar reserve");
  const c = await h.act(E, "policy", { targetFree: "25", enforcement: "contract" }, [erin]);
  assert.equal(c.result?.outcome, "scheduled", "setPolicy and setOperator are guarded calls");
  assert.equal((await E.state()).policy?.targetFree, "20000000", "the policy in force is unchanged until the change is applied");
});
