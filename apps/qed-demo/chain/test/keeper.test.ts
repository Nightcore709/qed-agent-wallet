/**
 * rail/keeper.ts, the shared test market's keeper (experiments/r8/D7-validation remedy R2 for Q-049).
 *
 * Unit: the trade rule alone (no chain). On a real local chain: with QED_RAIL_KEEPER_BPS=10 one household converts
 * 26,000 tINR, more than the 23,139 tINR that, without a keeper, push the shared venues out of the authority budget's
 * fixed band and refuse every workspace's conversions (measured in experiments/r8/D7-validation, E1); with the keeper
 * every conversion executes and the venues' mid stays inside the band. A party with no workspace then sells 350 tUSD
 * from the public faucet into the deep pool: a conversion is refused until the keeper's next tick, then executes. The
 * band itself never moves, and with the keeper off (the default) nothing changes.
 */
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { homedir } from "node:os";
import { join } from "node:path";
import { parseEther, toHex, type Address } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { cpmmOut, deviationBps, isqrt, keeperTrades, type KeeperPool } from "../rail/keeper.ts";
import { startHost, type TestHost } from "./helpers.ts";
import { SoftwarePasskey } from "./passkey.ts";
import type { Rail } from "../rail/host.ts";
import type { AuthorityView } from "../types.ts";

process.env.PATH = `${join(homedir(), ".foundry", "bin")}:${process.env.PATH}`;

// ───────────── the rule ─────────────
const a = (n: number) => `0x${n.toString(16).padStart(40, "0")}` as Address;
const deep = (r0: bigint, r1: bigint): KeeperPool => ({ pool: a(1), token0: a(10), token1: a(11), r0, r1, feeBps: 30, target0: 840_000_000n, target1: 100_000_000_000n });

test("the keeper's rule: nothing within theta; outside it, one trade that brings the pool back to its deployed price, in the right direction", () => {
  assert.equal(isqrt(10n ** 30n), 10n ** 15n);
  assert.equal(isqrt(99n), 9n);
  assert.deepEqual(keeperTrades([deep(840_000_000n, 100_000_000_000n)], 10), [], "at its deployed price");
  assert.deepEqual(keeperTrades([deep(840_500_000n, 100_000_000_000n)], 10), [], "6 bps off: within theta");
  // tINR (token0) per tUSD (token1) 40 bps above: tUSD is dear, so the keeper sells tUSD
  const up = deep(841_680_000n, 99_800_000_000n);
  assert.ok(deviationBps(up) > 39 && deviationBps(up) < 41);
  const [t] = keeperTrades([up], 10);
  assert.equal(t.tokenIn, a(11));
  const after = { ...up, r1: up.r1 + t.amountIn, r0: up.r0 - cpmmOut(t.amountIn, up.r1, up.r0, 30) };
  assert.ok(Math.abs(deviationBps(after)) < 1, `back within 1 bp of the deployed price: ${deviationBps(after).toFixed(3)} bps`);
  // 40 bps below: tUSD is cheap, so the keeper sells tINR
  const down = deep(838_320_000n, 100_200_000_000n);
  const [u] = keeperTrades([down], 10);
  assert.equal(u.tokenIn, a(10));
  const after2 = { ...down, r0: down.r0 + u.amountIn, r1: down.r1 - cpmmOut(u.amountIn, down.r0, down.r1, 30) };
  assert.ok(Math.abs(deviationBps(after2)) < 1);
  // the decoy at its own deployed price (1% off the others) is left alone
  const decoy: KeeperPool = { pool: a(2), token0: a(10), token1: a(11), r0: 42_000_000n, r1: 4_950_000_000n, feeBps: 100, target0: 42_000_000n, target1: 4_950_000_000n };
  assert.deepEqual(keeperTrades([decoy], 10), []);
});

// ───────────── on a real local chain ─────────────
const ana = new SoftwarePasskey();
const clock = { offset: 0 };
let h: TestHost, A: Rail;
const view = async () => (await A.cosigner.authority()) as AuthorityView;
/** The co-signer's figure: Σ tINR over Σ tUSD reserves of the direct venues, in tINR per tUSD. */
async function mid(): Promise<number> {
  const m = h.host.market!;
  let inr = 0, usd = 0;
  for (const i of [0, 1, 4]) {
    const p = m.inrPools[i];
    const [r0, r1] = (await A.read(p, A.v.abi.CPMMPoolAbi, "getReserves")) as [bigint, bigint];
    const t0 = (await A.read(p, A.v.abi.CPMMPoolAbi, "token0")) as Address;
    const [ri, ru] = t0.toLowerCase() === m.inr.toLowerCase() ? [r0, r1] : [r1, r0];
    inr += Number(ri) / 100; usd += Number(ru) / 1e6;
  }
  return inr / usd;
}

before(async () => {
  h = await startHost("keeper", 18789, { heartbeatMs: 3_600_000, keeperBps: 10, wallClock: () => Date.now() + clock.offset });
  A = await h.workspace("ana-home", [ana]);
  for (const [k, p] of [["provision", {}], ["mandate", { maxPerPayment: "10000", maxPerPeriod: "10000", maxTotal: "1000000", validDays: 30 }], ["grant", { amount: "1000" }]] as const) assert.equal((await h.act(A, k, p, [ana])).result?.outcome, "executed", k);
});
after(async () => { await h?.stop(); });

test("with the keeper, 26,000 tINR of one-way conversions (beyond the 23,139 that otherwise refuse everyone's) all execute, and the mid stays inside the fixed band", { timeout: 300_000 }, async () => {
  const band0 = (await view()).references[0];
  for (let n = 0; n < 11; n++) {
    if (n > 0 && n % 4 === 0) { clock.offset += 86_400_000 + 120_000; await h.host.tick(); } // the vault's daily cap is 10,000 tINR
    const amount = n < 10 ? "2500" : "1000";
    const j = await h.act(A, "convert", { amount }, [ana]);
    assert.equal(j.result?.outcome, "executed", `conversion ${n}: ${j.result?.summary}`);
    await h.host.tick(); // the heartbeat: the keeper's pass
    const m = await mid();
    assert.ok(m >= 83.58 && m <= 84.42, `after conversion ${n} the mid is ${m.toFixed(4)}, inside the band`);
  }
  const trades = h.host.store.decisions(500).filter((d: any) => d.kind === "keeper-trade");
  assert.ok(trades.length >= 5, `the keeper traded (${trades.length} trades)`);
  assert.deepEqual((await view()).references[0], band0, "the reference band never moved");
});

test("a faucet griefer's push refuses a conversion only until the keeper's next tick", async () => {
  assert.equal((await h.act(A, "mandate", { maxPerPayment: "10000", maxPerPeriod: "10000", maxTotal: "1000000", validDays: 30 }, [ana])).result?.outcome, "executed");
  const m = h.host.market!, V = A.v, fn = V.chain.fn;
  const G = privateKeyToAccount(generatePrivateKey());
  await A.rpc("anvil_setBalance", [G.address, toHex(parseEther("1"))]);
  await A.c.send(G, m.usd, fn(V.abi.TestUSDAbi, "faucet"));
  // sell faucet tUSD in 50 tUSD steps, split over the direct venues in proportion to their tUSD reserves (so they move
  // together), until the mid is below the band; one faucet draw is 1,000 tUSD
  let sold = 0n;
  while ((await mid()) >= 83.58 && sold < 1_000_000_000n) {
    for (const i of [0, 1, 4]) {
      const p = m.inrPools[i];
      const [r0, r1] = (await A.read(p, V.abi.CPMMPoolAbi, "getReserves")) as [bigint, bigint];
      const t0 = ((await A.read(p, V.abi.CPMMPoolAbi, "token0")) as Address).toLowerCase() === m.usd.toLowerCase();
      const [ru, ri] = t0 ? [r0, r1] : [r1, r0];
      const amt = (50_000_000n * ru) / 119_950_000_000n;
      const out = cpmmOut(amt, ru, ri, Number(await A.read(p, V.abi.CPMMPoolAbi, "feeBps")));
      await A.c.send(G, m.usd, fn(V.abi.TestUSDAbi, "transfer", [p, amt]));
      await A.c.send(G, p, fn(V.abi.CPMMPoolAbi, "swap", [t0 ? 0n : out, t0 ? out : 0n, G.address, "0x"]));
    }
    sold += 50_000_000n;
  }
  assert.ok((await mid()) < 83.58, `pushed below the band with ${Number(sold) / 1e6} tUSD of one faucet draw`);
  const refused = await h.act(A, "convert", { amount: "10" }, [ana]);
  assert.equal(refused.result?.outcome, "refused", "refused while the mid is outside the band");
  await h.host.tick();
  const ok = await h.act(A, "convert", { amount: "10" }, [ana]);
  assert.equal(ok.result?.outcome, "executed", `after the keeper's tick: ${ok.result?.summary}`);
});
