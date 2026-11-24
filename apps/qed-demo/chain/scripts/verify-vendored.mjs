/**
 * Re-checks that the vendored copies are unmodified.
 *
 *   node scripts/verify-vendored.mjs            compare with the recorded hashes AND with the release folder
 *   node scripts/verify-vendored.mjs --offline  compare with the recorded hashes only (release folder not needed)
 *   node scripts/verify-vendored.mjs --release <dir> [--tree <dir> [--with-zk]] [--json]
 *
 * Checks, for the default tier and (when it has been enabled) the zk-optional tier:
 *   1. every listed file exists and its SHA-256 equals the recorded one;
 *   2. no file exists in the vendored tree that is not listed;
 *   3. with the release folder: the release file still hashes to the recorded value, the release's own saved
 *      manifest agrees for every fingerprinted file, and the plan still selects exactly the listed files;
 *   4. neither excluded key file is present, and no vendored file contains either key value
 *      (compared by value; nothing is printed).
 * `--tree <dir>` checks an assembled copy instead of the committed tree: the default tier, and with `--with-zk`
 * the zk-optional tier laid over it.
 * Exits 1 on any problem. The release folder is only read.
 */
import { createHash } from "node:crypto";
import { existsSync, lstatSync, readFileSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { NEVER, RELEASE_MANIFEST, expandPlan } from "./vendor-plan.mjs";

const PKG = resolve(fileURLToPath(new URL("..", import.meta.url)));
const args = process.argv.slice(2);
const arg = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
const offline = args.includes("--offline");
const RELEASE = resolve(arg("--release") ?? join(homedir(), "qed-approved-release"));
const TREE = arg("--tree") ? resolve(arg("--tree")) : null;
const sha256 = (buf) => createHash("sha256").update(buf).digest("hex");

const problems = [];
const report = { checkedAt: new Date().toISOString(), mode: offline ? "recorded hashes only" : "recorded hashes and release folder", tiers: {} };

function listFiles(root) {
  const out = [];
  const walk = (rel) => {
    const abs = join(root, rel);
    const st = lstatSync(abs);
    if (st.isSymbolicLink()) { problems.push(`symbolic link in vendored tree: ${rel}`); return; }
    if (st.isDirectory()) for (const name of readdirSync(abs).sort()) walk(rel ? `${rel}/${name}` : name);
    else if (st.isFile()) out.push(rel);
  };
  if (existsSync(root)) walk("");
  return out;
}

const haveRelease = !offline && existsSync(join(RELEASE, "agent/src/abi/contracts.ts"));
if (!offline && !haveRelease) problems.push(`release folder not found at ${RELEASE} (use --offline to check recorded hashes only)`);
const saved = haveRelease ? JSON.parse(readFileSync(join(RELEASE, RELEASE_MANIFEST), "utf8")) : null;

const keyNeedles = [];
if (haveRelease) {
  const hpPath = join(RELEASE, NEVER[0].source);
  if (existsSync(hpPath)) {
    const hp = JSON.parse(readFileSync(hpPath, "utf8"));
    for (const [k, v] of Object.entries(hp)) if (/private.?key/i.test(k) && typeof v === "string" && /^0x[0-9a-fA-F]{64}$/.test(v)) keyNeedles.push(v.slice(2).toLowerCase());
  }
}

function checkTier(name, manifestPath, root, required) {
  const t = { root, listed: 0, present: 0, hashMatches: 0, releaseMatches: null, fingerprintMatches: null, extras: 0, enabled: true };
  report.tiers[name] = t;
  if (!existsSync(manifestPath)) { problems.push(`${name}: manifest missing at ${manifestPath}`); return []; }
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  t.listed = manifest.files.length;
  if (manifest.modified?.length) t.modifiedDeclared = manifest.modified.length;
  if (!existsSync(root)) {
    t.enabled = false;
    if (required) problems.push(`${name}: vendored tree missing at ${root}`);
    return manifest.files;
  }
  const listed = new Map(manifest.files.map((e) => [e.source, e]));
  for (const e of manifest.files) {
    const abs = join(root, e.source);
    if (!existsSync(abs)) { problems.push(`${name}: missing ${e.source}`); continue; }
    t.present++;
    const buf = readFileSync(abs);
    if (sha256(buf) === e.sha256) t.hashMatches++;
    else problems.push(`${name}: CHANGED ${e.source}`);
    if (keyNeedles.length) {
      const text = buf.toString("latin1").toLowerCase();
      if (keyNeedles.some((n) => text.includes(n))) problems.push(`${name}: ${e.source} contains an excluded key value`);
    }
  }
  if (!TREE) for (const f of listFiles(root)) if (!listed.has(f)) { t.extras++; problems.push(`${name}: unlisted file ${f}`); }
  if (haveRelease) {
    t.releaseMatches = 0; t.fingerprintMatches = 0;
    for (const e of manifest.files) {
      const src = join(RELEASE, e.source);
      if (!existsSync(src)) { problems.push(`${name}: source gone from the release: ${e.source}`); continue; }
      if (sha256(readFileSync(src)) === e.sha256) t.releaseMatches++;
      else problems.push(`${name}: release file differs from the recorded hash: ${e.source}`);
      if (Object.hasOwn(saved.files, e.source)) {
        if (saved.files[e.source] === e.sha256) t.fingerprintMatches++;
        else problems.push(`${name}: release fingerprint differs for ${e.source}`);
      }
    }
  }
  return manifest.files;
}

const defaultRoot = TREE ?? join(PKG, "vendor");
const zkRoot = TREE ?? join(PKG, "zk-optional", "vendor");
const defFiles = checkTier("default", join(PKG, "VENDORED.json"), defaultRoot, true);
const withZk = args.includes("--with-zk");
const zkFiles = TREE && !withZk ? [] : checkTier("zk-optional", join(PKG, "zk-optional", "VENDORED-ZK.json"), zkRoot, !!TREE);

if (TREE) {
  // An assembled tree may also hold run output; only report source files that are not listed anywhere.
  const all = new Set([...defFiles, ...zkFiles].map((e) => e.source));
  report.treeFilesNotListed = listFiles(TREE).filter((f) => !all.has(f) && !/^(out|cache|node_modules|evidence\/demo-runs|evidence\/local|review|deployments\/31337\.json)(\/|$)/.test(f)).length;
}

if (haveRelease) {
  const plan = expandPlan(RELEASE);
  const want = new Map(plan.map((p) => [p.source, p.tier]));
  const have = new Map([...defFiles.map((e) => [e.source, "default"]), ...zkFiles.map((e) => [e.source, "zk-optional"])]);
  for (const [s, tier] of want) if (have.get(s) !== tier) problems.push(`plan selects ${s} (${tier}) but the manifest ${have.has(s) ? `lists it as ${have.get(s)}` : "does not list it"}`);
  for (const s of have.keys()) if (!want.has(s)) problems.push(`manifest lists ${s} but the plan no longer selects it`);
  const covered = new Set(have.keys());
  report.releaseRuntimeFiles = saved.fileCount;
  report.releaseRuntimeDigest = saved.digest;
  report.runtimeFilesNotInEitherTier = Object.keys(saved.files).filter((f) => !covered.has(f)).sort();
}

// The two excluded files must not exist anywhere in this package, under any name they had in the release.
const forbiddenNames = [];
const scan = (dir) => {
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name === ".git") continue;
    const abs = join(dir, name);
    const st = lstatSync(abs);
    if (st.isSymbolicLink()) continue;
    if (st.isDirectory()) scan(abs);
    else if (name === "honeypot.json" && /ethereum-sepolia/.test(abs)) forbiddenNames.push(abs.slice(PKG.length + 1));
    else if (name === "data.json" && /(^|\/)site\//.test(abs.slice(PKG.length + 1))) forbiddenNames.push(abs.slice(PKG.length + 1));
  }
};
scan(PKG);
for (const f of forbiddenNames) problems.push(`excluded file present: ${f}`);
report.excludedKeyFilesPresent = forbiddenNames.length;
report.keyValuesComparedAgainst = keyNeedles.length;

report.problems = problems;
report.ok = problems.length === 0;
if (args.includes("--json")) console.log(JSON.stringify(report, null, 1));
else {
  for (const [name, t] of Object.entries(report.tiers)) {
    console.log(`${name}: ${t.enabled ? `${t.hashMatches}/${t.listed} files match their recorded SHA-256` : `not enabled (${t.listed} files listed, none copied)`}` +
      (t.enabled && t.releaseMatches !== null ? `; ${t.releaseMatches}/${t.listed} equal the release folder; ${t.fingerprintMatches} equal the release's saved fingerprint` : "") +
      (t.enabled && !TREE ? `; unlisted files: ${t.extras}` : ""));
  }
  if (report.runtimeFilesNotInEitherTier) console.log(`release runtime files (${report.releaseRuntimeFiles}, digest ${report.releaseRuntimeDigest.slice(0, 12)}…) not in either tier: ${JSON.stringify(report.runtimeFilesNotInEitherTier)}`);
  console.log(`excluded key files present: ${report.excludedKeyFilesPresent}; key values compared against: ${report.keyValuesComparedAgainst}`);
  console.log(report.ok ? "OK: vendored copies are unmodified" : `FAILED: ${problems.length} problem(s)\n  ${problems.slice(0, 40).join("\n  ")}`);
}
process.exit(report.ok ? 0 : 1);
