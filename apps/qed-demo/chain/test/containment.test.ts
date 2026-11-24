/**
 * R13 on the rail: containing a passkey the wallet has suspended, on a real local chain (the owner-account build
 * chain/accounts/READY.json declares; Anvil on 127.0.0.1 within the ports this run was given, stopped by the test):
 *   - a new workspace's owner account is deployed with this workspace's sentinel key and the release's protective calls;
 *   - freeze-signer sends QEDOwnerAccount.freeze from that key: the frozen passkey's approval is refused on the chain
 *     at once (for an owner action, and for a mandate's ERC-1271 signature), while the other passkey acts as before;
 *     freezing it again does nothing; a recovery key or an unknown key cannot be frozen;
 *   - the sentinel key holds no other power: it is no signer, and nothing it sends can execute or sign for the account.
 */
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { encodeFunctionData, getAddress, type Hex } from "viem";
import { generateRecoveryCode, RecoveryKey } from "../accounts/webauthn.ts";
import { key, startHost, type TestHost } from "./helpers.ts";
import { SoftwarePasskey, passkeyApproval } from "./passkey.ts";
import { signerIdOf } from "../rail/webauthn.ts";
import type { Rail } from "../rail/host.ts";
import type { PasskeyAccountOwner } from "../rail/owner.ts";
import type { Job } from "../types.ts";

const PORT = Number(process.env.QED_CONTAINMENT_ANVIL_PORT ?? 10590);
let t: TestHost, W: Rail;
const laptop = new SoftwarePasskey(), phone = new SoftwarePasskey();
const ok = (j: Job, outcome = "executed") => assert.equal(j.result?.outcome, outcome, `${j.kind}: ${j.error ?? j.result?.summary}`);
const refusal = (code: string, words?: RegExp) => (e: { code?: string; message?: string }) => e.code === code && (!words || words.test(e.message ?? ""));
const idOf = (p: SoftwarePasskey) => signerIdOf(BigInt(p.publicKey.x), BigInt(p.publicKey.y)).toLowerCase() as Hex;
const acct = () => W.owner as PasskeyAccountOwner;
const freeze = async (signerId: string) => W.waitForJob(W.submit("freeze-signer", W.signers.freezeParams({ signerId }), key()).jobId);

before(async () => {
  t = await startHost("containment", PORT, { economyAnvilPort: PORT + 1 });
  W = await t.workspace("contain-home", [laptop, phone]);
  ok(await t.act(W, "provision", {}, [laptop]));
});
after(async () => { await t?.stop(); });

test("a new owner account carries this workspace's sentinel and the release's protective calls", async () => {
  const v = await W.signers.view();
  assert.equal(v.containment.byThisService, true);
  assert.equal(v.containment.protect, true);
  assert.equal(v.containment.sentinel, W.sentinel!.address.toLowerCase());
  assert.deepEqual(v.signers.map((s) => s.frozen), [false, false]);
  const protective = (await acct().read("protectiveCalls")) as { target: string; selector: string }[];
  assert.equal(protective.length, 7, "pause, bumpEpoch and revokeMandate on both vaults, and the policy's revoke");
  assert.ok(protective.every((p) => [W.a.vault, W.a.reserve, W.a.treasuryPolicy].map((a) => getAddress(a!)).includes(getAddress(p.target))));
  // the sentinel is not a signer: every signer is a P-256 passkey key, and the account has two
  assert.equal(v.memberCount, 2);
});

test("freezing a suspended passkey: its approvals are refused on the chain at once; the other passkey acts as before", async () => {
  // before: the phone pauses and resumes alone (threshold 1)
  ok(await t.act(W, "pause", {}, [phone]));
  ok(await t.act(W, "resume", {}, [phone]));
  ok(await freeze(idOf(phone)));
  const v = await W.signers.view();
  assert.equal(v.signers.find((s) => s.signerId === idOf(phone))!.frozen, true);
  assert.equal(v.signers.find((s) => s.signerId === idOf(laptop))!.frozen, false);
  // the account itself refuses the phone's approval: checked on chain before anything is sent
  const p = await W.propose({ kind: "pause", params: {} });
  await assert.rejects(() => W.executeChecked(p.id, passkeyApproval(p, [phone], W.now()), key()), refusal("approval_signature_invalid", /FrozenSigner/));
  W.cancelProposal(p.id);
  // the laptop is untouched
  ok(await t.act(W, "pause", {}, [laptop]));
  ok(await t.act(W, "resume", {}, [laptop]));
  // again: nothing to do
  ok(await freeze(idOf(phone)), "no-action");
});

test("only members can be frozen, and the sentinel key can do nothing else on the account", async () => {
  const rk = new RecoveryKey(generateRecoveryCode());
  const hex = (v: bigint) => `0x${v.toString(16).padStart(64, "0")}`;
  ok(await t.act(W, "add-signer", { x: hex(rk.x), y: hex(rk.y), role: "recovery" }, [laptop]));
  ok(await freeze(signerIdOf(rk.x, rk.y).toLowerCase()), "refused");
  ok(await freeze(`0x${"ab".repeat(32)}`), "refused");
  // from the sentinel key: an execute with no member approval, and ERC-1271 with nothing, are refused
  const execute = encodeFunctionData({ abi: acct().abi, functionName: "execute", args: [[{ target: W.a.vault, value: 0n, data: "0x8456cb59" }], await acct().read("nonce"), BigInt(Math.floor(Date.now() / 1000) + 600), []] } as never);
  await assert.rejects(() => W.pub.call({ account: W.sentinel!.address, to: acct().address, data: execute }), /NotEnoughApprovals|reverted/);
  const magic = (await acct().read("isValidSignature", [`0x${"11".repeat(32)}`, "0x"]).catch(() => "0xffffffff")) as string;
  assert.notEqual(magic.toLowerCase(), "0x1626ba7e");
  // and it cannot unfreeze: only the account itself (its unfrozen admin quorum, through execute) can
  const unfreeze = encodeFunctionData({ abi: acct().abi, functionName: "unfreeze", args: [idOf(phone)] } as never);
  await assert.rejects(() => W.pub.call({ account: W.sentinel!.address, to: acct().address, data: unfreeze }), /OnlySelf|reverted/);
});
