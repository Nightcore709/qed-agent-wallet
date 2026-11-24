/**
 * R7-038 (GL5): an indicative quote, an executable quote and a fill are three different things for an on-chain conversion, and an
 * executable quote's expiry is enforced by the vault contract (QEDVault.CertificateNotActive). The vendored contracts are not changed.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { homedir } from "node:os";
import { join } from "node:path";
import { toHex } from "viem";
import { key, startRail } from "./helpers.ts";
import { devAccount } from "../rail/keys.ts";
import { executableQuote, expiredText, expiryVerdict } from "../rail/quote-kinds.ts";

process.env.PATH = `${join(homedir(), ".foundry", "bin")}:${process.env.PATH}`;

test("expiry verdict: valid inside the window, expired after it, not yet before it; the later of the two clocks decides", () => {
  const q = { validFrom: 1000, expiresAt: 2000 };
  assert.deepEqual(expiryVerdict(q, 1500, 1400), { state: "valid" });
  assert.deepEqual(expiryVerdict(q, 2000, 2000), { state: "valid" }, "the contract refuses only after expiresAt");
  assert.equal(expiryVerdict(q, 2001, 1000).state, "expired");
  assert.equal(expiryVerdict(q, 1500, 2600).state, "expired", "a chain ahead of the rail's clock decides: the contract reads block time");
  assert.equal(expiryVerdict(q, 900, 900).state, "not-yet");
  const e = expiryVerdict(q, 2060, 2060) as Extract<ReturnType<typeof expiryVerdict>, { state: "expired" }>;
  assert.match(expiredText(e), /expired at 1970-01-01T00:33:20\.000Z, 60 s ago.*CertificateNotActive.*nothing was sent/s);
});

test("indicative, executable and fill are three distinct records; the contract refuses the executable quote once it has expired", { timeout: 240_000 }, async () => {
  const t = await startRail("quote-kinds", 13008, { heartbeatMs: 3_600_000 });
  try {
    await t.ready();
    // 1 · indicative: a reading of the pools. No floor, no certificate, no expiry, and it says so.
    const ind = await t.rail.quote("5");
    assert.equal(ind.kind, "indicative");
    assert.equal(ind.execution, "none");
    assert.match(ind.source.priceType, /indicative reading/);
    assert.match(ind.notice, /not an offer.*no floor and no expiry/s);
    assert.equal("floor" in ind || "certificate" in ind || "expiresAt" in ind, false);

    // 2 · a conversion: the executable quote and the fill are kept apart from each other and from the indicative reading
    const job = await t.act("convert", { amount: "5" });
    assert.equal(job.result?.outcome, "executed", job.error ?? "");
    const trade = (await t.rail.state()).lastTrade!;
    assert.equal(trade.executable!.kind, "executable");
    assert.equal(trade.fill!.kind, "fill");
    assert.equal(trade.executable!.floor, trade.floor, "the executable quote is the order the co-signer signed");
    assert.ok(trade.executable!.expiresAt > trade.executable!.validFrom);
    assert.deepEqual([trade.executable!.enforcedBy, trade.executable!.contractError], ["contract", "CertificateNotActive"]);
    assert.equal(trade.fill!.amountOut, trade.amountOut);
    assert.equal(trade.fill!.hash, trade.hash);
    assert.ok(BigInt(trade.fill!.amountOut) >= BigInt(trade.executable!.floor), "the fill is at or above the floor: a different number from it");

    // 3 · expiry on chain: a certificate the co-signer signed, sent after its window, is refused by the contract
    const A = t.rail.a, V = t.rail.v, am = t.rail.activeMandate()!;
    const nonce = `expiry-${key()}`;
    const instructionSig = await devAccount("OWNER").signMessage({ message: V.cosigner.ownerTradeMessage(A.vault, 5_000_000n, A.usd, A.eur, A.reserve, nonce) });
    const r = await t.rail.cosigner.evaluateTrade({ mandate: am.mandate, ownerSig: am.ownerSig, module: A.exec, tokenIn: A.usd, tokenOut: A.eur, recipient: A.reserve, amountIn: 5_000_000n, instruction: "expiry", nonce, instructionSig, brainEngine: "test" });
    assert.equal(r.approved, true, r.reasons?.join("; "));
    const ex = executableQuote(r.certificate!, r.order!);
    const tp = await V.trader.planTrade(t.rail.pub, A.exec, A.usd, A.eur, 5_000_000n);
    const data = V.chain.fn(V.abi.QEDExecutionAbi, "trade", [am.mandate, am.ownerSig, r.certificate, r.signature, r.order, V.trader.hopsForChain(tp.plan.route), V.trader.pricesForChain(tp.plan.prices)]);
    assert.equal(await t.rail.c.simulateError(t.rail.K.OPERATOR.address, A.exec, data), undefined, "inside its window the same call is not refused for expiry");
    await t.rail.rpc("evm_increaseTime", [toHex(ex.expiresAt - Number((await t.rail.pub.getBlock()).timestamp) + 60)]);
    await t.rail.rpc("evm_mine", []);
    const err = await t.rail.c.simulateError(t.rail.K.OPERATOR.address, A.exec, data);
    assert.equal(err!.name, "CertificateNotActive");
  } finally { await t.stop(); }
});
