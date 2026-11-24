/**
 * The co-signer's deny list has a source and a date, and every change to it is recorded first (F-033; R13 audit P7).
 * No chain: rail/denylist.ts only.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { freshDir } from "./helpers.ts";
import { BUILT_IN_AS_OF, BUILT_IN_SOURCE, denyHistory, loadDenyList, setDenyList } from "../rail/denylist.ts";

const A = "0x00000000000000000000000000000000000000a1", B = "0x00000000000000000000000000000000000000b2";

test("with no list set, the list in force is the built-in test entry, labelled as such and dated", () => {
  const dir = freshDir("deny-default");
  const l = loadDenyList(dir, [A]);
  assert.deepEqual([l.source, l.asOf, l.builtIn, l.entries.map((e) => e.address)], [BUILT_IN_SOURCE, BUILT_IN_AS_OF, true, ["0x00000000000000000000000000000000000000A1"]]);
  assert.match(l.source, /Not a sanctions list/);
  assert.deepEqual(denyHistory(dir), []);
});

test("a change needs a source, a date and well-formed entries; it is recorded before it is in force, and the history is a chain", () => {
  const dir = freshDir("deny-set");
  for (const [bad, why] of [[{ asOf: "2026-11-24", entries: [] }, /source/], [{ source: "x list", asOf: "24/11/2026", entries: [] }, /asOf/], [{ source: "x list", asOf: "2026-11-24", entries: [{ address: "0x12", reason: "r" }] }, /not an address/], [{ source: "x list", asOf: "2026-11-24", entries: [{ address: A, reason: "" }] }, /reason/], [{ source: "x list", asOf: "2026-11-24", entries: [{ address: A, reason: "r" }, { address: A.toUpperCase().replace("0X", "0x"), reason: "r" }] }, /twice/]] as const) {
    assert.throws(() => setDenyList(dir, bad, "owner"), why);
  }
  assert.throws(() => setDenyList(dir, { source: "x list", asOf: "2026-11-24", entries: [] }, " "), /who made the change/);
  assert.deepEqual(denyHistory(dir), [], "nothing refused was recorded");
  const r1 = setDenyList(dir, { source: "Owner's list, written by hand", asOf: "2026-11-24", entries: [{ address: A, reason: "test payee that must never be paid" }] }, "owner", new Date("2026-11-24T10:00:00Z"));
  const r2 = setDenyList(dir, { source: "Owner's list, written by hand", asOf: "2026-11-25", entries: [{ address: A, reason: "test payee" }, { address: B, reason: "second" }] }, "owner", new Date("2026-11-25T10:00:00Z"));
  assert.equal(r1.previous, null);
  assert.equal(r2.previous, r1.hash);
  const now = loadDenyList(dir, [A]);
  assert.deepEqual([now.source, now.asOf, now.entries.length, now.builtIn], ["Owner's list, written by hand", "2026-11-25", 2, undefined]);
  assert.deepEqual(denyHistory(dir).map((r) => [r.by, r.asOf, r.entries.length]), [["owner", "2026-11-24", 1], ["owner", "2026-11-25", 2]]);
  // a record changed afterwards is found
  const f = join(dir, "denylist-history.jsonl");
  writeFileSync(f, readFileSync(f, "utf8").replace('"by":"owner"', '"by":"someone else"'));
  assert.throws(() => denyHistory(dir), /does not hold at record 1/);
});
