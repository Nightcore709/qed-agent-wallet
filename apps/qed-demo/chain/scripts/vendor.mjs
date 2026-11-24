/**
 * Copies the planned files out of the approved release into this package and writes the two manifests.
 *
 *   node scripts/vendor.mjs [--release <dir>]
 *
 * The release folder is only read. Nothing is built, installed or run there.
 * Refuses to copy a file that contains either published honeypot key value (compared by value, never printed).
 * Writes:
 *   VENDORED.json                 every file copied into vendor/ with its source path and SHA-256
 *   zk-optional/VENDORED-ZK.json  the GPL-3.0 tier: listed with hashes, NOT copied (see zk-optional/enable.mjs)
 */
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { NEVER, OMITTED, RELEASE_ID, RELEASE_MANIFEST, expandPlan } from "./vendor-plan.mjs";

const PKG = resolve(fileURLToPath(new URL("..", import.meta.url)));
const args = process.argv.slice(2);
const arg = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
const RELEASE = resolve(arg("--release") ?? join(homedir(), "qed-approved-release"));
const sha256 = (buf) => createHash("sha256").update(buf).digest("hex");

if (!existsSync(join(RELEASE, "agent/src/abi/contracts.ts"))) {
  console.error(`Release folder not found at ${RELEASE}`);
  process.exit(1);
}

// The two key values that must never enter the workspace, read only to compare against.
const keyNeedles = [];
{
  const hpPath = join(RELEASE, NEVER[0].source);
  if (existsSync(hpPath)) {
    const hp = JSON.parse(readFileSync(hpPath, "utf8"));
    for (const [k, v] of Object.entries(hp)) if (/private.?key/i.test(k) && typeof v === "string" && /^0x[0-9a-fA-F]{64}$/.test(v)) keyNeedles.push(v.slice(2).toLowerCase());
  }
}
const carriesExcludedKey = (buf) => {
  if (!keyNeedles.length) return false;
  const text = buf.toString("latin1").toLowerCase();
  return keyNeedles.some((n) => text.includes(n));
};

const saved = JSON.parse(readFileSync(join(RELEASE, RELEASE_MANIFEST), "utf8"));
const plan = expandPlan(RELEASE);

// Static-import closure: a default-tier file must not statically import a zk-optional file.
const tierOf = new Map(plan.map((p) => [p.source, p.tier]));
const closureProblems = [], dynamicZk = [];
for (const p of plan) {
  if (p.tier !== "default" || !/\.(ts|mjs|mts)$/.test(p.source)) continue;
  const text = readFileSync(join(RELEASE, p.source), "utf8");
  const specs = [];
  for (const m of text.matchAll(/^\s*(?:import|export)\s[^;'"]*?from\s*['"]([^'"]+)['"]/gm)) specs.push([m[1], "static"]);
  for (const m of text.matchAll(/^\s*import\s*['"]([^'"]+)['"]/gm)) specs.push([m[1], "static"]);
  for (const m of text.matchAll(/import\(\s*['"]([^'"]+)['"]\s*\)/g)) specs.push([m[1], "dynamic"]);
  for (const [spec, kind] of specs) {
    if (!spec.startsWith(".")) continue;
    let target = join(dirname(p.source), spec).split("\\").join("/");
    if (!tierOf.has(target) && target.endsWith(".js") && tierOf.has(target.slice(0, -3) + ".ts")) target = target.slice(0, -3) + ".ts";
    const tier = tierOf.get(target);
    if (tier === "zk-optional") (kind === "static" ? closureProblems : dynamicZk).push(`${p.source} -> ${target}`);
  }
}
if (closureProblems.length) {
  console.error("A default-tier file statically imports a zk-optional file:\n  " + closureProblems.join("\n  "));
  process.exit(1);
}

const now = new Date().toISOString();
const entries = { default: [], "zk-optional": [] };
const refusedForKeys = [];
const vendorRoot = join(PKG, "vendor");
rmSync(vendorRoot, { recursive: true, force: true });
for (const p of plan) {
  const src = join(RELEASE, p.source);
  const buf = readFileSync(src);
  if (carriesExcludedKey(buf)) { refusedForKeys.push(p.source); continue; }
  const hash = sha256(buf);
  const inManifest = Object.hasOwn(saved.files, p.source);
  const entry = {
    path: `${p.tier === "default" ? "vendor" : "zk-optional/vendor"}/${p.source}`,
    source: p.source,
    sha256: hash,
    bytes: statSync(src).size,
    licence: p.licence,
    note: p.note,
    releaseManifest: inManifest ? (saved.files[p.source] === hash ? "match" : "MISMATCH") : "not fingerprinted by the release",
  };
  entries[p.tier].push(entry);
  if (p.tier === "default") {
    const dest = join(vendorRoot, p.source);
    mkdirSync(dirname(dest), { recursive: true });
    copyFileSync(src, dest);
    if (sha256(readFileSync(dest)) !== hash) throw new Error(`copy of ${p.source} does not match its source`);
  }
}
if (refusedForKeys.length) {
  console.error("Refused: these planned files contain an excluded key value: " + refusedForKeys.join(", "));
  process.exit(1);
}
const mismatches = [...entries.default, ...entries["zk-optional"]].filter((e) => e.releaseManifest === "MISMATCH");
if (mismatches.length) {
  console.error("The release folder differs from its own saved manifest for: " + mismatches.map((e) => e.source).join(", "));
  process.exit(1);
}

// How the two tiers together relate to the release's fingerprinted runtime set.
const covered = new Set([...entries.default, ...entries["zk-optional"]].map((e) => e.source));
const runtimeNotCovered = Object.keys(saved.files).filter((f) => !covered.has(f)).sort();

const sum = (list) => list.reduce((a, e) => a + e.bytes, 0);
const head = {
  generatedAt: now,
  release: {
    id: RELEASE_ID,
    folder: "~/qed-approved-release (read-only; copied out, never built, installed or run)",
    savedManifest: RELEASE_MANIFEST,
    savedManifestDigest: saved.digest,
    savedManifestFileCount: saved.fileCount,
  },
};
const fingerprinted = (list) => list.filter((e) => e.releaseManifest === "match").length;
writeFileSync(join(PKG, "VENDORED.json"), JSON.stringify({
  schema: "qed.chain-rail.vendored/v1",
  ...head,
  tier: "default",
  root: "vendor",
  summary: {
    files: entries.default.length,
    bytes: sum(entries.default),
    matchingTheReleaseFingerprint: fingerprinted(entries.default),
    notFingerprintedByTheRelease: entries.default.length - fingerprinted(entries.default),
    modified: 0,
  },
  runtimeFilesOfTheReleaseNotInEitherTier: runtimeNotCovered,
  dynamicImportsIntoTheZkTier: dynamicZk,
  neverCopied: NEVER,
  omitted: OMITTED,
  modified: [],
  files: entries.default,
}, null, 1) + "\n");
mkdirSync(join(PKG, "zk-optional"), { recursive: true });
writeFileSync(join(PKG, "zk-optional", "VENDORED-ZK.json"), JSON.stringify({
  schema: "qed.chain-rail.vendored/v1",
  ...head,
  tier: "zk-optional",
  root: "zk-optional/vendor",
  copiedByDefault: false,
  summary: { files: entries["zk-optional"].length, bytes: sum(entries["zk-optional"]), matchingTheReleaseFingerprint: fingerprinted(entries["zk-optional"]), modified: 0 },
  modified: [],
  files: entries["zk-optional"],
}, null, 1) + "\n");

console.log(JSON.stringify({
  release: RELEASE_ID,
  savedManifestDigest: saved.digest,
  default: { files: entries.default.length, bytes: sum(entries.default), fingerprintMatches: fingerprinted(entries.default) },
  zkOptional: { files: entries["zk-optional"].length, bytes: sum(entries["zk-optional"]), fingerprintMatches: fingerprinted(entries["zk-optional"]), copied: false },
  runtimeFilesOfTheReleaseNotInEitherTier: runtimeNotCovered,
  dynamicImportsIntoTheZkTier: dynamicZk,
  keyValuesCheckedAgainst: keyNeedles.length,
}, null, 1));
