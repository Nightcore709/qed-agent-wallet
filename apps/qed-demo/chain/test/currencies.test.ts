/**
 * Money-model stage S5 on a real chain: a workspace whose test tokens are tEUR (6 decimals, the release's), tJPY (0) and
 * tBHD (3), chosen at setup under the owner's passkey signature, against a real wallet service (serve.ts, multi-tenant)
 * on a real Anvil. What is checked:
 *   - the signed configuration: refused unsigned, signed over other terms, by a key that is not a member, or with fewer
 *     member signatures than the account's admin threshold; nothing is deployed for a refused set;
 *   - the workspace: its vaults hold tEUR and tJPY, its venues route through tBHD, the service's figures set in tINR are
 *     carried into tEUR at the genesis rates and rounded down, the co-signer's authority budget counts in tEUR;
 *   - provision (the currency set and its digest are in the terms the passkey signs), the opening grant in tEUR, a
 *     mandate, an owner grant of authority, a conversion tEUR → tJPY and a payment in tEUR;
 *   - the household's books (server/chain-books.ts) agree with the chain in each token, at its own decimals;
 *   - a default workspace beside it is exactly what it was: tINR and tUSD, no currency set recorded.
 * The service runs on 127.0.0.1:12690; its chain on a port browsers refuse, reached over its socket (rail/chain-socket.ts).
 */
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getAddress } from "viem";
import { freshDir, key } from "./helpers.ts";
import { RailHost } from "../rail/host.ts";
import { ORIGIN, RP_ID_HASH, SoftwarePasskey, passkeyApproval } from "./passkey.ts";
import { startService, type Service } from "./service-helper.ts";
import { verifyAssertionOffChain } from "../rail/webauthn.ts";
import { assetSetDigest, assetSetDocument, CHAIN_TOKENS, fromInr, unitsText } from "../../shared/chain-assets.ts";
import type { Accepted, Job, Proposal, WorkspaceView } from "../types.ts";

const server = (m: string) => import(join(import.meta.dirname, "..", "..", "server", m)) as Promise<any>;
process.env.QED_OFFLINE = "1";
delete process.env.ANTHROPIC_API_KEY;

const SET = { treasury: "EUR", reserve: "JPY", route: "BHD" } as const;
const WS = "fx-eur-jpy", HOME = "fx-default";
const owner = new SoftwarePasskey(), other = new SoftwarePasskey(), home = new SoftwarePasskey();
const docOf = (id: string, members: SoftwarePasskey[], threshold = 1, adminThreshold = threshold) => assetSetDocument({ workspaceId: id, rpIdHash: RP_ID_HASH, origin: ORIGIN, members: members.map((m) => m.publicKey), threshold, adminThreshold, currencies: SET });
const bodyOf = (id: string, signers: SoftwarePasskey[], digest = assetSetDigest(docOf(id, [owner]))) => ({ workspaceId: id, owner: owner.publicKey, rpIdHash: RP_ID_HASH, currencies: SET, authorization: { assertions: signers.map((s) => s.assert(digest)) } });

let s: Service;
const keyDir = mkdtempSync(join(tmpdir(), "qed-currencies-keys-"));
const was = { url: process.env.QED_RAIL_URL, token: process.env.QED_RAIL_TOKEN_FILE, keys: process.env.QED_KEY_DIR };

async function act(ws: string, kind: string, params: Record<string, unknown>, signer: SoftwarePasskey): Promise<Job> {
  const p = await s.call<Proposal>("POST", `/workspaces/${ws}/proposals`, { kind, params });
  assert.equal(p.status, 201, `${kind}: ${JSON.stringify(p.data)}`);
  const a = await s.call<Accepted>("POST", `/workspaces/${ws}/proposals/${p.data.id}/execute`, { approval: passkeyApproval(p.data, [signer]) }, { "Idempotency-Key": key() });
  assert.equal(a.status, 202, JSON.stringify(a.data));
  for (let i = 0; i < 900; i++) {
    const j = (await s.call<Job>("GET", `/workspaces/${ws}/jobs/${a.data.jobId}`)).data;
    if (["done", "failed", "interrupted", "reorged"].includes(j.status)) {
      assert.equal(j.result?.outcome, "executed", `${kind}: ${j.error ?? j.result?.summary}`);
      return j;
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`${kind} did not finish`);
}

test("the owner's signed configuration is verified off the chain as the owner account would verify it", () => {
  const digest = assetSetDigest(docOf(WS, [owner]));
  const expect = { digest, rpIdHash: RP_ID_HASH, origin: ORIGIN, key: owner.publicKey };
  assert.equal(verifyAssertionOffChain(owner.assert(digest), expect), null);
  const refusals: [string, unknown, RegExp][] = [
    ["other terms", owner.assert(assetSetDigest(docOf("fx-other", [owner]))), /challenge/],
    ["another origin", owner.assert(digest, { origin: "http://localhost:5174" }), /origin/],
    ["another relying party", owner.assert(digest, { rpId: "example.com" }), /relying party/],
    ["no user verification", owner.assert(digest, { flags: 0x01 }), /user verification/],
    ["no user presence", owner.assert(digest, { flags: 0x04 }), /user presence/],
    ["backed up but not eligible", owner.assert(digest, { flags: 0x15 }), /backup/],
    ["a registration, not an assertion", owner.assert(digest, { type: "webauthn.create" }), /webauthn\.get/],
    ["another key's signature", { ...other.assert(digest), publicKey: owner.publicKey }, /signature/],
    ["malformed", { publicKey: owner.publicKey, authenticatorData: "0x00", clientDataJSON: "{}", signature: "0x00" }, /./],
  ];
  for (const [what, a, why] of refusals) assert.match(String(verifyAssertionOffChain(a as never, expect)), why, what);
});

test("under the release's authority rule a currency set other than the default is refused before anything is read, spent or deployed", async () => {
  // the release's C12 allowance is a fixed 10 units of whatever the vault holds: another token would change its value
  const host = new RailHost({ dataDir: freshDir("currencies-release"), mode: "multi-tenant", authority: "release" });
  host.status = "ready";
  await assert.rejects(() => host.createWorkspace(bodyOf("fx-release", [owner], assetSetDigest(docOf("fx-release", [owner])))), (e: { code?: string; http?: number }) => e.code === "currencies_need_authority_budget" && e.http === 409);
});

before(async () => {
  const { testKeys } = await server("key-fixture.ts");
  s = await startService("currencies", 12690, 12680, { env: { QED_RAIL_MODE: "multi-tenant", QED_RAIL_ECONOMY_ANVIL_PORT: "12681", QED_RAIL_ACCOUNT_DELAY_S: "60", QED_RAIL_ACCOUNT_RECOVERY_DELAY_S: "60" }, workspace: null });
  process.env.QED_KEY_DIR = testKeys(keyDir).dir;
  process.env.QED_RAIL_URL = `http://127.0.0.1:${s.port}`;
  process.env.QED_RAIL_TOKEN_FILE = join(s.dir, "rail.token");
});
after(async () => {
  await s?.stop();
  rmSync(keyDir, { recursive: true, force: true });
  for (const [k, v] of [["QED_RAIL_URL", was.url], ["QED_RAIL_TOKEN_FILE", was.token], ["QED_KEY_DIR", was.keys]] as const) if (v === undefined) delete process.env[k]; else process.env[k] = v;
});

test("a currency set the owner did not sign is refused, and nothing is deployed for it", { timeout: 120_000 }, async () => {
  const unsigned = { workspaceId: WS, owner: owner.publicKey, rpIdHash: RP_ID_HASH, currencies: SET };
  const cases: [string, unknown, number, string][] = [
    ["unsigned", unsigned, 403, "currencies_not_signed"],
    ["signed over another workspace's terms", bodyOf(WS, [owner], assetSetDigest(docOf("fx-other", [owner]))), 403, "currencies_not_signed"],
    ["signed by a key that is not a member", bodyOf(WS, [other]), 403, "currencies_not_signed"],
    ["not three different currencies", { ...unsigned, currencies: { treasury: "EUR", reserve: "EUR", route: "BHD" } }, 422, "invalid_currencies"],
    ["a currency the paper bank does not hold", { ...unsigned, currencies: { treasury: "KWD", reserve: "JPY", route: "BHD" } }, 422, "invalid_currencies"],
  ];
  for (const [what, body, status, code] of cases) {
    const r = await s.call("POST", "/workspaces", body);
    assert.equal(r.status, status, `${what}: ${JSON.stringify(r.data)}`);
    assert.equal(r.data.error.code, code, what);
  }
  // two members and an admin threshold of two: one member's signature is not enough
  const pair = { workspaceId: "fx-pair", owner: { signers: [owner.publicKey, other.publicKey], threshold: 1, adminThreshold: 2 }, rpIdHash: RP_ID_HASH, currencies: SET };
  const pairDigest = assetSetDigest(docOf("fx-pair", [owner, other], 1, 2));
  const one = await s.call("POST", "/workspaces", { ...pair, authorization: { assertions: [owner.assert(pairDigest)] } });
  assert.equal(one.status, 403, JSON.stringify(one.data));
  assert.match(one.data.error.message, /2 of the workspace's members/);
  const twice = await s.call("POST", "/workspaces", { ...pair, authorization: { assertions: [owner.assert(pairDigest), owner.assert(pairDigest)] } });
  assert.equal(twice.status, 403, "the same member twice counts once");
  for (const id of [WS, "fx-pair"]) assert.equal((await s.call("GET", `/workspaces/${id}`)).status, 404, `${id} was not created`);
});

test("EUR, JPY and BHD test tokens: created under the owner's signature, provisioned, converted and paid, with the books agreeing in each token", { timeout: 600_000 }, async () => {
  const created = await s.call<WorkspaceView>("POST", "/workspaces", bodyOf(WS, [owner]));
  assert.equal(created.status, 201, JSON.stringify(created.data));
  const w = created.data;
  assert.deepEqual([w.asset.symbol, w.asset.decimals, w.reserveAsset.symbol, w.reserveAsset.decimals], ["tEUR", 6, "tJPY", 0]);
  assert.deepEqual(w.currencies && [w.currencies.treasury, w.currencies.reserve, w.currencies.route, w.currencies.default], ["EUR", "JPY", "BHD", false]);
  assert.equal(w.currencies!.digest, assetSetDigest(docOf(WS, [owner])));
  assert.deepEqual([w.routeAsset!.symbol, w.routeAsset!.decimals], ["tBHD", 3]);
  // the same request again (a lost reply) is the same workspace; another set under the same id is refused
  const again = await s.call<WorkspaceView>("POST", "/workspaces", bodyOf(WS, [owner]));
  assert.deepEqual([again.status, again.data.duplicate, again.data.ownerAccount], [200, true, w.ownerAccount]);
  const differ = await s.call("POST", "/workspaces", { ...bodyOf(WS, [owner]), currencies: { treasury: "EUR", reserve: "BHD", route: "JPY" }, authorization: { assertions: [owner.assert(assetSetDigest(assetSetDocument({ workspaceId: WS, rpIdHash: RP_ID_HASH, origin: ORIGIN, members: [owner.publicKey], threshold: 1, adminThreshold: 1, currencies: { treasury: "EUR", reserve: "BHD", route: "JPY" } })))] } });
  assert.equal(differ.status, 409, JSON.stringify(differ.data));

  // the provision terms the passkey signs name the set and its digest; the grant follows in tEUR
  const p = await s.call<Proposal>("POST", `/workspaces/${WS}/proposals`, { kind: "provision", params: {} });
  assert.equal(p.status, 201, JSON.stringify(p.data));
  assert.deepEqual(p.data.terms.currencies, { treasury: "EUR", reserve: "JPY", route: "BHD", digest: w.currencies!.digest, tokens: ["tEUR", "tJPY", "tBHD"] });
  assert.match(p.data.summary, /test tEUR/);
  await act(WS, "provision", {}, owner);
  const st0 = (await s.call("GET", `/workspaces/${WS}/state`)).data;
  const grantVault = fromInr(10_000_000n, "EUR"), grantOwner = fromInr(1_000_000n, "EUR");
  assert.equal(st0.treasury.balance, grantVault.toString(), "100,000.00 tINR of grant, carried into tEUR and rounded down");
  assert.equal(st0.ownerHolds.asset, grantOwner.toString());
  assert.equal(st0.treasury.dailyCap, fromInr(1_000_000n, "EUR").toString(), "the daily cap, 10,000.00 tINR, in tEUR");
  assert.deepEqual([st0.treasury.token, st0.treasury.decimals, st0.reserve.token, st0.reserve.decimals], ["tEUR", 6, "tJPY", 0]);
  assert.deepEqual(st0.venues.map((v: { label: string }) => v.label), ["tEUR/tJPY · 0.30% · deep", "tEUR/tJPY · 0.05% · thin", "tEUR/tBHD · 0.30%", "tJPY/tBHD · 0.30%", "tEUR/tJPY · 1.00% · off-market"]);
  assert.ok(st0.venues.every((v: { token0: string; token1: string }) => [v.token0, v.token1].every((t) => ["tEUR", "tJPY", "tBHD"].includes(t))), "every venue's tokens are named");

  // the co-signer's authority budget counts in tEUR: its base is 10.00 tINR carried into tEUR
  const lim = (await s.call("GET", `/workspaces/${WS}/payments/limits`)).data;
  assert.deepEqual([lim.authority.asset.symbol, lim.authority.asset.decimals, lim.authority.base], ["tEUR", 6, fromInr(1_000n, "EUR").toString()]);
  assert.equal(lim.authority.references[0].symbol, "tJPY");

  await act(WS, "mandate", { maxPerPayment: "25" }, owner);
  await act(WS, "grant", { amount: "5" }, owner);
  const conv = await act(WS, "convert", { amount: "10" }, owner);
  const pay = await act(WS, "pay", { payee: "CloudCo", amount: "1.5" }, owner);
  const st = (await s.call("GET", `/workspaces/${WS}/state`)).data;
  const out = BigInt(st.reserve.balance);
  // 10 tEUR at genesis is 1,630 tJPY (0.92 tEUR and 150 tJPY per tUSD); fees and the pools' depth take a little
  assert.ok(out > 1_600n && out <= 1_630n, `the reserve received ${out} tJPY`);

  const mv = (await s.call("GET", `/workspaces/${WS}/movements`)).data;
  assert.deepEqual(mv.tokens.map((t: { symbol: string; decimals: number }) => [t.symbol, t.decimals]), [["tEUR", 6], ["tJPY", 0]]);
  const legs = mv.movements.filter((m: { txHash: string }) => m.txHash === conv.result!.tx!.hash.toLowerCase());
  assert.deepEqual(legs.filter((m: { fromRole: string }) => m.fromRole === "treasury").map((m: { symbol: string; amount: string }) => [m.symbol, m.amount]), [["tEUR", "10000000"]]);
  assert.deepEqual(legs.filter((m: { toRole: string }) => m.toRole === "reserve").map((m: { symbol: string; amount: string }) => [m.symbol, m.amount]), [["tJPY", out.toString()]]);
  const spent = BigInt(legs.find((m: { fromRole: string }) => m.fromRole === "treasury").conversion.spent);
  assert.equal(BigInt(st.treasury.balance), grantVault - spent - 1_500_000n, "the treasury moved by what the conversion spent and what was paid");
  const paid = mv.movements.find((m: { txHash: string }) => m.txHash === pay.result!.tx!.hash.toLowerCase());
  assert.deepEqual([paid.symbol, paid.amount, paid.counterparty.label], ["tEUR", "1500000", "CloudCo"]);
  // what the holders hold of each token is the sum of its movements: nothing created, nothing lost (the reserve vault
  // holds no tEUR and the treasury no tJPY: a QEDVault takes only its own asset from the module)
  const chainOf: Record<string, bigint> = { tEUR: BigInt(st.treasury.balance) + BigInt(st.ownerHolds.asset), tJPY: BigInt(st.reserve.balance) + BigInt(st.ownerHolds.reserveAsset) };
  for (const t of mv.tokens as { symbol: string; address: string }[]) {
    const held = mv.movements.filter((m: { token: string }) => getAddress(m.token) === getAddress(t.address)).reduce((sum: bigint, m: { amount: string; fromRole: string | null; toRole: string | null }) => sum + (m.toRole ? BigInt(m.amount) : 0n) - (m.fromRole ? BigInt(m.amount) : 0n), 0n);
    assert.equal(held, chainOf[t.symbol], `${t.symbol}: the movements add up to the holders' balances`);
  }

  // the household's books, as the server keeps them, against the same service
  const [{ compareChainBooks }, { verifyLedger }, { saveVault }, { makeKit }] = await Promise.all(["chain-books.ts", "ledger.ts", "rail.ts", "testkit.ts"].map(server));
  const k = makeKit();
  k.clock.advance(Date.now() - k.clock.now());
  saveVault(k.db, k.userId, { railId: WS, request: { workspaceId: WS, owner: { signers: [], threshold: 1 }, rpIdHash: RP_ID_HASH, origin: ORIGIN }, credentialIds: [], createdAt: k.clock.now(), createdBy: k.userId } as never);
  // every job above is done at two confirmations (R7-036), so each movement is final and booked
  const books = await compareChainBooks({ dbPath: join(s.dir, "server-qed.db") }, k.db, k.userId, k.clock.now());
  assert.equal(books.state, "agrees", JSON.stringify(books));
  assert.deepEqual(books.assets.map((a: { symbol: string; decimals: number; words: string }) => [a.symbol, a.decimals, a.words]), [["tEUR", 6, "test euros"], ["tJPY", 0, "test yen"]]);
  for (const a of books.assets as { books: string; inFlight: string; chain: string; difference: string }[]) assert.equal(a.difference, "0");
  assert.deepEqual(verifyLedger(k.db, k.userId), [], "every booked entry balances in its own token");
  assert.equal(unitsText(BigInt(books.assets[1].chain), CHAIN_TOKENS.JPY.decimals), out.toString(), "the yen are whole units");
});

test("a default workspace beside it is what every workspace has been: tINR and tUSD through tEUR, no currency set recorded", { timeout: 300_000 }, async () => {
  const r = await s.call<WorkspaceView>("POST", "/workspaces", { workspaceId: HOME, owner: home.publicKey, rpIdHash: RP_ID_HASH });
  assert.equal(r.status, 201, JSON.stringify(r.data));
  assert.deepEqual([r.data.asset.symbol, r.data.asset.decimals, r.data.reserveAsset.symbol, r.data.reserveAsset.decimals], ["tINR", 2, "tUSD", 6]);
  assert.deepEqual(r.data.currencies && [r.data.currencies.default, r.data.currencies.digest], [true, null]);
  // spelling the default out is the same request as leaving it out: no signature, the same workspace
  const spelt = await s.call<WorkspaceView>("POST", "/workspaces", { workspaceId: HOME, owner: home.publicKey, rpIdHash: RP_ID_HASH, currencies: { treasury: "INR", reserve: "USD", route: "EUR" } });
  assert.deepEqual([spelt.status, spelt.data.duplicate], [200, true]);
  const p = await s.call<Proposal>("POST", `/workspaces/${HOME}/proposals`, { kind: "provision", params: {} });
  assert.equal(p.data.terms.currencies, undefined, "the default's provision terms are unchanged");
  await act(HOME, "provision", {}, home);
  const st = (await s.call("GET", `/workspaces/${HOME}/state`)).data;
  assert.equal(st.treasury.balance, "10000000");
  assert.deepEqual(st.venues.map((v: { label: string }) => v.label), ["tINR/tUSD · 0.30% · deep", "tINR/tUSD · 0.05% · thin", "tINR/tEUR · 0.30%", "tUSD/tEUR · 0.30% · deep (the release's pool)", "tINR/tUSD · 1.00% · off-market"]);
  const lim = (await s.call("GET", `/workspaces/${HOME}/payments/limits`)).data;
  // the band the rail has always used: 84 tINR per tUSD ± 0.5%, shown per whole token
  assert.deepEqual([lim.authority.asset.symbol, lim.authority.base, lim.authority.references[0].lo, lim.authority.references[0].hi], ["tINR", "1000", "83.58", "84.42"]);
});
