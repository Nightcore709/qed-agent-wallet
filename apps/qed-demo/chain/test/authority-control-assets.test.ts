/**
 * R7 decision D7 on a real local chain, control per asset (R8 D7 validation, experiments/r8/D7-validation, F-R8-3):
 * a QEDVault releases only its own asset, so tINR that reaches a workspace's tUSD reserve vault is locked there. With
 * the host's `controlAssets` the budget treats it as gone, not as money that came home:
 *   - the agent's promise to CloudCo, assigned by CloudCo (its creditor) to the workspace's reserve vault and settled
 *     there once due, has been paid out: it uses its amount, and the tINR sits in the reserve, which cannot move it;
 *   - an outside client's tINR escrow job paid to the reserve vault is not earnings, with the reason in words;
 *   - a conversion into tUSD for the reserve still uses only its cost against the reference.
 */
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { homedir } from "node:os";
import { join } from "node:path";
import { getAddress, keccak256, parseEther, toHex, type Address, type Hex } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { startHost, type TestHost } from "./helpers.ts";
import { SoftwarePasskey } from "./passkey.ts";
import type { Rail } from "../rail/host.ts";
import type { AuthorityView } from "../types.ts";

process.env.PATH = `${join(homedir(), ".foundry", "bin")}:${process.env.PATH}`;
const ana = new SoftwarePasskey();
const clock = { offset: 0 };
let h: TestHost, A: Rail;
const view = async () => (await A.cosigner.authority()) as AuthorityView;

before(async () => {
  h = await startHost("authority-control-assets", 18781, { heartbeatMs: 3_600_000, wallClock: () => Date.now() + clock.offset });
  A = await h.workspace("ana-home", [ana]);
  for (const [k, p] of [["provision", {}], ["mandate", { maxPerPayment: "2500" }], ["grant", { amount: "100" }]] as const) assert.equal((await h.act(A, k, p, [ana])).result?.outcome, "executed", k);
});
after(async () => { await h?.stop(); });

test("a promise its creditor assigns to the workspace's tUSD reserve vault and settles there has been paid out: it uses its amount, and the tINR is locked in the reserve", async () => {
  const V = A.v, fn = V.chain.fn, inr = A.a.asset!, cloud = A.K.CLOUDCO;
  const v0 = await view();
  const promise = await h.act(A, "pay", { payee: "CloudCo", amount: "7", dueInDays: 1 }, [ana]);
  assert.equal(promise.result?.outcome, "executed", promise.result?.summary);
  const v1 = await view();
  assert.deepEqual([v1.held, BigInt(v0.available) - BigInt(v1.available)], ["700", 700n], "a promise holds its amount");
  const id = BigInt((promise.result?.evidence as { liabilityId: string }).liabilityId);
  await A.rpc("anvil_setBalance", [cloud.address, toHex(parseEther("1"))]);
  await A.c.send(cloud, A.a.vault, fn(V.abi.QEDVaultAbi, "assign", [id, A.a.reserve])); // only the creditor may assign
  clock.offset += 86_400_000 + 120_000;
  await h.host.tick(); // the host realigns its chain to the (moved) wall clock
  await A.c.send(cloud, A.a.vault, fn(V.abi.QEDVaultAbi, "settle", [id])); // anyone may settle a due liability
  const locked = (await A.read(inr, V.abi.TestTokenAbi, "balanceOf", [A.a.reserve])) as bigint;
  assert.equal(locked, 700n, "the tINR now sits in the tUSD reserve vault, which transfers only tUSD");
  const v2 = await view();
  assert.deepEqual([v2.held, v2.usedBy.promisesPaid, v2.available], ["0", "700", (BigInt(v0.available) - 700n).toString()], "settled where the workspace cannot release it: paid out, not come home");
});

test("an outside client's tINR job paid to the tUSD reserve vault is not earnings; the same job paid to the vault is", async () => {
  const V = A.v, fn = V.chain.fn, escrow = h.host.market!.escrow, inr = A.a.asset!;
  const verifier = getAddress(`0x${"7e".repeat(20)}`);
  await A.rpc("anvil_setCode", [verifier, "0x60206000f3"]); // accepts every solution: the provider chooses the verifier
  const provider = privateKeyToAccount(generatePrivateKey()), client = privateKeyToAccount(generatePrivateKey());
  for (const who of [provider, client]) await A.rpc("anvil_setBalance", [who.address, toHex(parseEther("1"))]);
  let q = 0;
  const job = async (payee: Address, price: bigint) => {
    const now = await A.chainNow();
    const spec = toHex(`control-assets job ${++q}`);
    const quote = { provider: provider.address, payee, client: "0x0000000000000000000000000000000000000000", token: inr, price, verifier, specHash: keccak256(spec), deliverBy: now + 3600n, validUntil: now + 1800n, quoteId: keccak256(toHex(`ca-quote-${q}`)) };
    const sig = (await V.eip712.signQuote(provider, 31337, escrow, quote as never)) as Hex;
    await A.c.send(A.K.LP1, inr, fn(V.abi.TestTokenAbi, "mint", [client.address, price]));
    await A.c.send(client, inr, fn(V.abi.TestTokenAbi, "approve", [escrow, price]));
    await A.c.send(client, escrow, fn(V.abi.ProofEscrowAbi, "open", [quote, sig]));
    const id = (await A.read(escrow, V.abi.ProofEscrowAbi, "jobCount")) as bigint;
    await A.c.send(provider, escrow, fn(V.abi.ProofEscrowAbi, "deliver", [id, spec, "0x01"]));
    await A.rpc("evm_mine");
  };
  const v0 = await view();
  await job(A.a.reserve, 10_000n);
  const v1 = await view();
  assert.deepEqual([v1.earned, v1.notEarnings - v0.notEarnings], [v0.earned, 1], "paid where the workspace cannot release it: not earnings");
  await job(A.a.vault, 10_000n);
  const v2 = await view();
  assert.equal(BigInt(v2.earned) - BigInt(v1.earned), 5_000n, "⌊½ · 100.00⌋ = 50.00 tINR");
});

test("a conversion into tUSD for the reserve vault still uses only its cost against the reference", async () => {
  // the previous test moved the host's wall clock; a fresh mandate keeps the conversion inside its validity window
  assert.equal((await h.act(A, "mandate", { maxPerPayment: "2500" }, [ana])).result?.outcome, "executed");
  const v0 = await view();
  const c = await h.act(A, "convert", { amount: "10" }, [ana]);
  assert.equal(c.result?.outcome, "executed", c.result?.summary);
  const used = BigInt((await view()).usedBy.conversions) - BigInt(v0.usedBy.conversions);
  assert.ok(used > 0n && used < 20n, `a 10 tINR conversion used ${used} paise, its cost against the reference`);
});
