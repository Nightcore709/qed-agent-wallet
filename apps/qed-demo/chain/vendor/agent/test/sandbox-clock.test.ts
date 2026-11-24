import assert from "node:assert/strict";
import { test } from "node:test";
import { certificateNow } from "../src/sandboxClock.js";

test("local Anvil certificate windows use fresh time after long inactivity", () => {
  const fourHours = 4 * 3600;
  const wall = 1_800_000_000;
  const staleBlock = wall - 7 * 3600;
  const issuedAt = certificateNow(staleBlock, 31337, wall);
  const notBefore = issuedAt - 60;
  const expiresAt = issuedAt + fourHours;
  assert.equal(issuedAt, wall);
  assert.ok(wall >= notBefore && wall <= expiresAt);
  assert.ok(wall > staleBlock + fourHours, "the old block-based window would already have expired");
});

test("Anvil never issues timestamps older than a time-travelled chain", () => {
  assert.equal(certificateNow(2000, 31337, 1000), 2000);
});

test("public chain certificate validity ignores the server wall clock", () => {
  assert.equal(certificateNow(1000, 11155111, 99_999), 1000);
  assert.equal(certificateNow(1000, 84532, 99_999), 1000);
});

test("invalid timestamps are rejected", () => {
  assert.throws(() => certificateNow(-1, 31337, 2000), RangeError);
  assert.throws(() => certificateNow(NaN, 31337, 2000), RangeError);
});
