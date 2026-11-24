/**
 * Decision D-A (22 Nov 2026, taken by the R7 orchestrator, not by the owner; docs/r7/00-ARCHITECTURE-DECISIONS.md): the rail's fork of the release's co-signer (rail/cosigner-engine.ts) changes two
 * things only: owner signatures are checked as the vault checks them (ECDSA for an owner without code, ERC-1271 for a
 * contract owner), and the asset-dependent constants and record texts use the vault asset's decimals.
 *
 *   1. The fork is exactly what scripts/fork-cosigner.mjs generates from the unmodified vendored file.
 *   2. Differential: for an ordinary-key owner on 6-decimal tUSD, the fork and the release's engine certify or refuse
 *      identically across a scenario set that makes each check fail alone, and across 60 seeded random requests.
 *      Payments: the same checks, details, reasons, record hashes, certificates and signatures. Conversions: the same
 *      verdict, order, quote and every check except the three decision D-K4a redefines (scripts/fork-cosigner.mjs change
 *      5: P2, T2, T3), the same certificate apart from its evidence hash, and a signature exactly when the release signs.
 *      That is the one expectation D-K4a changes, and why: the redefined checks are written into the decision record, so
 *      the record's hash (the certificate's evidenceHash) and the signature over the certificate differ for conversions.
 *      Where they differ, the test also checks what D-K4a says: the fork has no T2 where T1 fails, its P2 holds where no
 *      tranche is due, and its T3 passes wherever the release's does on this chain.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { getAddress, keccak256, toHex, type Address, type Hex, type LocalAccount } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { CHAIN, freshDir, startRail } from "./helpers.ts";
import { devAccount } from "../rail/keys.ts";
import { createForkedPolicyEngine } from "../rail/cosigner-engine.ts";
import { verifyVendoredTree } from "../rail/vendored.ts";

test("the fork is exactly the generator's output from the unmodified vendored co-signer", async () => {
  const gen = "../scripts/fork-cosigner.mjs";
  const { generate } = await import(gen);
  assert.equal(readFileSync(join(CHAIN, "rail", "cosigner-engine.ts"), "utf8"), generate(), "rail/cosigner-engine.ts = generate(vendor/agent/src/roles/cosigner.ts)");
  assert.equal(verifyVendoredTree(join(CHAIN, "vendor"), false).ok, true, "the vendored co-signer itself is unmodified");
});

/** A small deterministic generator (mulberry32), so the randomised set is the same on every run. */
const rng = (seed: number) => () => { seed |= 0; seed = (seed + 0x6d2b79f5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
const canon = (x: unknown) => JSON.stringify(x, (_, v) => (typeof v === "bigint" ? `${v}n` : v));

test("differential: for an ordinary-key owner on 6-decimal tUSD, the fork and the release engine decide identically across the check scenarios and 60 seeded random requests", { timeout: 240_000 }, async () => {
  const t = await startRail("fork-diff", 18752, { heartbeatMs: 3_600_000 });
  try {
    await t.ready();
    const v = t.rail.v, a = t.rail.a, K = t.rail.K, owner = devAccount("OWNER");
    const chain = new v.chain.Chain$(t.rail.anvil.url, 31337);
    const key = privateKeyToAccount(keccak256(toHex("qed-fork-differential-cosigner")));
    const cfg = (dir: string) => ({ vault: a.vault, lens: a.lens, escrow: a.vault, owner: owner.address, vendorKeys: {}, catalogPrices: {}, denylist: [K.MALLORY.address], deployBlock: BigInt(a.deployBlock), recordsDir: dir });
    const release = new v.cosigner.PolicyEngine(chain, key, cfg(freshDir("diff-release")) as never);
    const fork = new (createForkedPolicyEngine(v))(chain as never, key, cfg(freshDir("diff-fork")) as never);
    const am = t.rail.activeMandate()!;
    const stranger = privateKeyToAccount(keccak256(toHex("qed-fork-differential-stranger")));
    const now = await t.rail.chainNow();
    const otherMandate = { ...am.mandate, salt: keccak256(toHex("other")) };
    const expired = { ...am.mandate, validFrom: now - 7200n, validUntil: now - 3600n, salt: keccak256(toHex("expired")) };
    const staleEpoch = { ...am.mandate, epoch: am.mandate.epoch + 1n, salt: keccak256(toHex("stale")) };
    const noModulePayee = { ...am.mandate, payees: [a.reserve, K.CLOUDCO.address], salt: keccak256(toHex("no-module")) };
    const sig = (m: unknown, by: LocalAccount = owner) => v.eip712.signMandate(by, 31337, m as never) as Promise<Hex>;
    const mandates = { active: { mandate: am.mandate, ownerSig: am.ownerSig }, byStranger: { mandate: otherMandate, ownerSig: await sig(otherMandate, stranger) }, expired: { mandate: expired, ownerSig: await sig(expired) }, staleEpoch: { mandate: staleEpoch, ownerSig: await sig(staleEpoch) }, noModulePayee: { mandate: noModulePayee, ownerSig: await sig(noModulePayee) } };
    const U = (x: number) => BigInt(Math.round(x * 1e6));
    let n = 0;
    const trade = async (o: { amount?: bigint; signer?: LocalAccount; m?: keyof typeof mandates; recipient?: Address; module?: Address; nonce?: string; policy?: boolean; policySigner?: LocalAccount }) => {
      const amountIn = o.amount ?? U(10), nonce = o.nonce ?? `diff-t-${++n}`, recipient = o.recipient ?? a.reserve, module = o.module ?? a.exec, m = mandates[o.m ?? "active"];
      const base = { ...m, module, tokenIn: a.usd, tokenOut: a.eur, recipient, amountIn, instruction: "differential", nonce, brainEngine: "test" };
      if (o.policy) {
        const policy = { vault: a.vault, reserve: a.reserve, tokenIn: a.usd, tokenOut: a.eur, targetFree: U(30), maxTranche: U(25), minTranche: U(2), maxImpactBps: 150, validUntil: now + 86_400n, nonce: `rail-policy-00000000-${++n}` };
        return { kind: "trade" as const, req: { ...base, policy, policySig: await (o.policySigner ?? owner).signMessage({ message: v.treasury.policyMessage(policy as never) }) } };
      }
      return { kind: "trade" as const, req: { ...base, instructionSig: await (o.signer ?? owner).signMessage({ message: v.cosigner.ownerTradeMessage(a.vault, amountIn, a.usd, a.eur, recipient, nonce) }) } };
    };
    const payment = async (o: { amount?: bigint; signer?: LocalAccount; m?: keyof typeof mandates; payee?: Address; nonce?: string; dueInDays?: number }) => {
      const amount = o.amount ?? U(3), nonce = o.nonce ?? `diff-p-${++n}`, payee = o.payee ?? K.CLOUDCO.address, m = mandates[o.m ?? "active"];
      return { kind: "payment" as const, req: { kind: "owner-instructed", ...m, payee, amount, dueInDays: o.dueInDays, instruction: "differential", nonce, instructionSig: await (o.signer ?? owner).signMessage({ message: v.cosigner.ownerInstructionMessage(a.vault, payee, amount, o.dueInDays, nonce) }) } };
    };
    // the scenario set: each check of the release failing alone, and approvals of every shape
    const scenarios = [
      await trade({}), await trade({ amount: U(0.000001) }), await trade({ m: "byStranger" }), await trade({ m: "expired" }), await trade({ m: "staleEpoch" }), await trade({ signer: stranger }),
      await trade({ nonce: "diff-t-1" }), await trade({ recipient: K.CLOUDCO.address }), await trade({ module: K.CLOUDCO.address }), await trade({ m: "noModulePayee" }), await trade({ amount: U(96) }), await trade({ recipient: K.MALLORY.address }),
      await trade({ policy: true, amount: U(8) }), await trade({ policy: true, amount: U(24) }), await trade({ policy: true, policySigner: stranger }),
      await payment({}), await payment({ dueInDays: 7 }), await payment({ signer: stranger }), await payment({ nonce: "diff-p-15" }), await payment({ payee: K.MALLORY.address }), await payment({ payee: getAddress(`0x${"ab".repeat(20)}`) }),
      await payment({ amount: U(11) }), await payment({ amount: U(96) }), await payment({ m: "byStranger" }), await payment({ m: "expired" }),
    ];
    const r = rng(0x7e5a);
    const pick = <T,>(xs: T[]) => xs[Math.floor(r() * xs.length)];
    const random = [];
    for (let i = 0; i < 60; i++) {
      const amount = BigInt(Math.floor(r() * 120_000_000)) + 1n;
      const signer = r() < 0.25 ? stranger : owner, m = r() < 0.15 ? pick(["byStranger", "expired", "staleEpoch"] as const) : "active";
      const repeat = r() < 0.15 && n > 0 ? `diff-${r() < 0.5 ? "t" : "p"}-${1 + Math.floor(r() * n)}` : undefined;
      random.push(r() < 0.5 ? await trade({ amount, signer, m, nonce: repeat, recipient: r() < 0.1 ? pick([K.CLOUDCO.address, K.MALLORY.address]) : undefined, policy: r() < 0.15 }) : await payment({ amount: amount / 10n, signer, m, nonce: repeat, payee: r() < 0.1 ? pick([K.MALLORY.address, a.reserve]) : undefined, dueInDays: r() < 0.2 ? 1 + Math.floor(r() * 30) : undefined }));
    }
    const run = async (engine: any, x: { kind: "trade" | "payment"; req: any }) => {
      try {
        const out = x.kind === "trade" ? await engine.evaluateTrade(x.req) : await engine.evaluate(x.req);
        return canon({ approved: out.approved, checks: out.checks.map((c: any) => [c.id, c.name, c.pass, c.detail]), reasons: out.reasons, evidenceHash: out.evidenceHash, certificate: out.certificate ?? null, signature: out.signature ?? null, order: out.order ?? null, quote: out.quote?.amountOut ?? null });
      } catch (e) { return canon({ threw: String((e as Error).message).split("\n")[0] }); }
    };
    // D-K4a: for conversions, everything but the three redefined checks and what hashes or signs them
    const K4 = new Set(["P2", "T2", "T3"]);
    const stable = (text: string) => {
      const o = JSON.parse(text);
      if (o.threw) return text;
      return canon({ ...o, checks: o.checks.filter(([id]: [string]) => !K4.has(id)), reasons: o.reasons.filter((r: string) => !K4.has(r.split(" ")[0]!)), evidenceHash: null, certificate: o.certificate ? { ...o.certificate, evidenceHash: null } : null, signature: o.signature ? "signed" : null });
    };
    const k4 = { t1Fails: 0, p1Fails: 0, t3: 0 };
    const tally = { approved: 0, refused: 0, threw: 0 }, failing = new Set<string>();
    for (const [i, x] of [...scenarios, ...random].entries()) {
      // Both engines read the wall clock (the release's certificateNow takes max(block, wall) on chain 31337): give the
      // pair the same instant, so that the same inputs are compared even across a second boundary.
      const realNow = Date.now, instant = realNow();
      Date.now = () => instant;
      let want: string, got: string;
      try { [want, got] = [await run(release, x), await run(fork, x)]; } finally { Date.now = realNow; }
      const label = `request ${i} (${i < scenarios.length ? "scenario" : "random"} ${x.kind})`;
      if (x.kind === "payment") assert.equal(got, want, label);
      else {
        assert.equal(stable(got), stable(want), label);
        const [w, g] = [JSON.parse(want), JSON.parse(got)];
        if (!w.threw) {
          const pass = (o: any, id: string) => o.checks.find(([c]: [string]) => c === id)?.[2] as boolean | undefined;
          if (pass(w, "T1") === false) { k4.t1Fails++; assert.equal(pass(g, "T2"), undefined, `${label}: no T2 without T1`); }
          if (pass(w, "P1") === false) { k4.p1Fails++; assert.equal(pass(g, "P2"), true, `${label}: P2 holds where no tranche is due`); }
          if (pass(w, "T3") === true) { k4.t3++; assert.equal(pass(g, "T3"), true, `${label}: T3`); }
        }
      }
      const o = JSON.parse(want);
      if (o.threw) tally.threw++; else if (o.approved) tally.approved++; else tally.refused++;
      if (!o.threw) for (const [id, , pass] of o.checks) if (!pass) failing.add(id);
    }
    assert.ok(tally.approved >= 10 && tally.refused >= 30, `both outcomes covered: ${JSON.stringify(tally)}`);
    assert.ok(k4.t1Fails >= 1 && k4.t3 >= 10, `the redefined checks were reached: ${JSON.stringify(k4)}`);
    for (const id of ["C1", "C2", "C3", "C6", "C9", "C9b", "C10", "C11", "C12", "P2"]) assert.ok(failing.has(id), `check ${id} failed at least once, identically in both`);
  } finally { await t.stop(); }
});
