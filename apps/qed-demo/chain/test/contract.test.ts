/**
 * The contract with the backend: every route is documented in README.md, and the files the backend imports
 * (types.ts, terms.ts) load on plain Node with no loader and no build step. And the parity register keeps to its
 * own rule: its counts are computed from its rows, and a row is Verified only if it names a test that exists.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { CHAIN } from "./helpers.ts";
import { ROUTES } from "../rail/http.ts";
import { canonicalTerms, checkApproval, hashTerms } from "../terms.ts";

test("every route is documented in README.md with its method and path", () => {
  const readme = readFileSync(join(CHAIN, "README.md"), "utf8");
  for (const r of ROUTES) {
    assert.ok(readme.includes(`\`${r.method} ${r.path}\``), `README.md documents ${r.method} ${r.path}`);
    assert.ok(new RegExp(`^(GET|POST) ${r.path.replace(/:\w+/g, "[^\\s?]+")}`, "m").test(readme), `README.md has an example of ${r.method} ${r.path}`);
  }
  assert.equal(new Set(ROUTES.map((r) => `${r.method} ${r.path}`)).size, ROUTES.length, "no duplicate route");
  assert.deepEqual(ROUTES.filter((r) => !r.auth).map((r) => r.path), ["/health"], "only /health is open");
});

test("PARITY.md: 86 rows, the Counts section is computed from them, every Verified row names a test and every named test exists", async () => {
  const counter = "../scripts/parity-counts.mjs";
  const { readParity, STATUS_WORDS } = await import(counter);
  const p = readParity(CHAIN);
  assert.deepEqual(p.problems, []);
  assert.equal(p.rows.length, 86);
  assert.equal(STATUS_WORDS.reduce((a: number, w: string) => a + p.total[w], 0), 86, "every row has exactly one of the six status words");
  assert.ok(p.text.includes(p.block), "the Counts table in PARITY.md is not the one its rows give: run `node scripts/parity-counts.mjs --write`");
  assert.ok(!/PLACEHOLDER|SUITE_(DATE|NODE|TABLE)/.test(p.text), "no placeholder is left in the register");
  // the owner's rule: Verified only if something ran. A Verified row without a named test fails the check above.
  const verified = p.rows.filter((r: { word: string }) => r.word === "Verified");
  assert.ok(verified.length > 0 && verified.every((r: { evidence: string }) => /`[^`]+\.(test\.ts|test\.mjs|integration\.mjs|t\.sol)`/.test(r.evidence)));
});

test("types.ts and terms.ts load on plain Node (no loader), and the terms hash is canonical", () => {
  const script = `const t = await import(${JSON.stringify(join(CHAIN, "terms.ts"))}); const y = await import(${JSON.stringify(join(CHAIN, "types.ts"))}); console.log(t.hashTerms({ b: 1, a: [2n, "x"], c: undefined }), y.NETWORK_LABEL.length > 0);`;
  const out = execFileSync(process.execPath, ["--input-type=module", "-e", script], { env: { PATH: process.env.PATH ?? "" } }).toString().trim();
  assert.equal(out, `${hashTerms({ a: ["2", "x"], b: 1 })} true`);
  assert.equal(canonicalTerms({ b: 1, a: { d: 2n, c: [true, null] } }), '{"a":{"c":[true,null],"d":"2"},"b":1}');
  assert.match(hashTerms({}), /^sha256:[0-9a-f]{64}$/);
  assert.throws(() => canonicalTerms({ x: Number.NaN }), /non-finite/);
  const terms = { kind: "convert", amountIn: "10000000" }, now = Date.now();
  const window = { notBeforeMs: now - 1000, notAfterMs: now + 600_000, nowMs: now };
  const good = { approvalId: "ap-1", docHash: "sha256:x", termsHash: hashTerms(terms), confirmedAt: new Date(now).toISOString(), method: "passkey" };
  assert.deepEqual(checkApproval(good, terms, window), good);
  assert.throws(() => checkApproval(good, { ...terms, amountIn: "11000000" }, window), (e: { code: string }) => e.code === "approval_terms_mismatch");
  assert.throws(() => checkApproval({ ...good, approvalId: "has spaces" }, terms, window), (e: { code: string }) => e.code === "approval_malformed");
  assert.throws(() => checkApproval(null, terms, window), (e: { code: string }) => e.code === "approval_required");
});
