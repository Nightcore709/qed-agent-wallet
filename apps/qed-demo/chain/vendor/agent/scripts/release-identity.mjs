/**
 * Release identity: the release ID plus a deterministic SHA-256 fingerprint over every runtime file the
 * production image executes, serves or reads. DEPLOY_APPROVED_EXISTING_RAILWAY.sh stages exactly these files
 * and writes release-manifest.json beside them; the Docker build re-verifies the manifest; /api/health reports
 * it; POST_DEPLOY_SMOKE.py requires the live values to equal the local release. Only Node built-ins are used,
 * so the check runs before dependencies are installed.
 *
 *   node agent/scripts/release-identity.mjs --print            # releaseId and digest of this checkout
 *   node agent/scripts/release-identity.mjs --stage <dir>      # copy the runtime files + manifest into <dir>
 *   node agent/scripts/release-identity.mjs --verify [--root <dir>]
 *
 * Digest = SHA-256 of the sorted lines "<sha256(file)>  <posix path>\n". Timestamps, permissions and the
 * manifest itself are not part of it.
 */
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const RELEASE_ID = "qed-20261023-health-gate-v3";
export const MANIFEST = "release-manifest.json";
export const SCHEMA = "qed.release-manifest/v1";

/** Everything the image needs at runtime. Directories are included recursively. */
export const RUNTIME_PATHS = Object.freeze([
  // configuration and the exact dependency lock the image installs
  "package.json", "package-lock.json", "tsconfig.json", "Dockerfile", ".dockerignore",
  // backend, agent, sandbox and the compiled contract ABIs + bytecode it deploys (agent/src/abi)
  "agent/src", "agent/scripts",
  // frontend
  "product/index.html",
  // contract sources and compiler configuration behind the embedded bytecode
  "contracts/src", "foundry.toml", "foundry.lock",
  // Groth16 circuit artifacts used by the private-optimality workbench
  "circuits/build/private_minvar_js", "circuits/build/private_minvar_final.zkey", "circuits/private_minvar.vkey.json",
  // historical Sepolia evidence (/api/evidence and the scripted scenarios), verified sources, relay records
  "evidence/ethereum-sepolia", "verification", "relay", "deployments/11155111.json",
  "LICENSE", "ATTRIBUTIONS.md",
]);
// Generated or machine-local files inside the included directories are never part of a release.
const EXCLUDED = [/(^|\/)\.DS_Store$/, /\.log$/, /\.private\.json$/, /(^|\/)\.env(\.|$)/, /(^|\/)\.keys\.env/, /\.pem$/, /-31337[^/]*\.json$/];

const sha256 = (data) => createHash("sha256").update(data).digest("hex");

function walk(root, rel, out) {
  const abs = join(root, rel);
  const st = lstatSync(abs);
  if (st.isSymbolicLink()) throw new Error(`Refusing symbolic link in release: ${rel}`);
  if (st.isDirectory()) {
    for (const name of readdirSync(abs).sort()) walk(root, `${rel}/${name}`, out);
  } else if (st.isFile()) {
    if (!EXCLUDED.some((re) => re.test(rel))) out.push(rel);
  }
}

/** Lists and hashes the runtime files under `root`; missing allowlisted paths are reported, not skipped. */
export function computeIdentity(root) {
  const files = [], missing = [];
  for (const p of RUNTIME_PATHS) {
    if (!existsSync(join(root, p))) missing.push(p);
    else walk(root, p, files);
  }
  files.sort();
  const hashes = Object.fromEntries(files.map((f) => [f, sha256(readFileSync(join(root, f)))]));
  const digest = sha256(files.map((f) => `${hashes[f]}  ${f}\n`).join(""));
  return { releaseId: RELEASE_ID, digest, fileCount: files.length, files: hashes, missing };
}

function manifestFor(identity) {
  return { schema: SCHEMA, releaseId: identity.releaseId, algorithm: "sha256 over sorted '<sha256>  <path>' lines", digest: identity.digest, fileCount: identity.fileCount, files: identity.files };
}

/** Compares `root` with its release-manifest.json. Returns the problems found (empty when it matches). */
export function verifyRoot(root) {
  const path = join(root, MANIFEST);
  if (!existsSync(path)) return { ok: false, manifest: null, problems: [`${MANIFEST} is missing`] };
  let manifest;
  try { manifest = JSON.parse(readFileSync(path, "utf8")); } catch { return { ok: false, manifest: null, problems: [`${MANIFEST} is not valid JSON`] }; }
  const id = computeIdentity(root), problems = [];
  if (manifest.schema !== SCHEMA) problems.push(`unexpected manifest schema ${manifest.schema}`);
  if (manifest.releaseId !== RELEASE_ID) problems.push(`manifest release ${manifest.releaseId} ≠ code release ${RELEASE_ID}`);
  for (const p of id.missing) problems.push(`missing runtime path ${p}`);
  const expected = manifest.files ?? {};
  for (const f of Object.keys(expected)) if (!(f in id.files)) problems.push(`missing file ${f}`);
  for (const [f, h] of Object.entries(id.files)) {
    if (!(f in expected)) problems.push(`unexpected file ${f}`);
    else if (expected[f] !== h) problems.push(`changed file ${f}`);
  }
  if (manifest.digest !== id.digest) problems.push(`digest ${id.digest} ≠ manifest ${manifest.digest}`);
  return { ok: problems.length === 0, manifest, computed: id.digest, problems };
}

/** What the running server reports: the embedded manifest and whether this filesystem still matches it. */
export function runtimeIdentity(root) {
  try {
    const v = verifyRoot(root);
    return { releaseId: RELEASE_ID, sourceDigest: v.manifest?.digest ?? null, sourceVerified: v.ok, sourceProblems: v.problems.length };
  } catch {
    return { releaseId: RELEASE_ID, sourceDigest: null, sourceVerified: false, sourceProblems: -1 };
  }
}

/** Copies exactly the runtime files into an empty `dest` and writes the manifest there. */
export function stage(root, dest) {
  if (existsSync(dest) && readdirSync(dest).length) throw new Error(`Stage directory ${dest} is not empty`);
  const id = computeIdentity(root);
  if (id.missing.length) throw new Error(`Runtime paths missing: ${id.missing.join(", ")}`);
  for (const f of Object.keys(id.files)) {
    mkdirSync(dirname(join(dest, f)), { recursive: true });
    copyFileSync(join(root, f), join(dest, f));
  }
  writeFileSync(join(dest, MANIFEST), JSON.stringify(manifestFor(id), null, 1) + "\n");
  return id;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const arg = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
  const root = resolve(arg("--root") ?? fileURLToPath(new URL("../..", import.meta.url)));
  try {
    if (args.includes("--stage")) {
      const dest = resolve(arg("--stage"));
      const id = stage(root, dest);
      console.log(JSON.stringify({ staged: dest, releaseId: id.releaseId, digest: id.digest, fileCount: id.fileCount }));
    } else if (args.includes("--verify")) {
      const v = verifyRoot(root);
      if (!v.ok) {
        console.error(`RELEASE MANIFEST VERIFICATION FAILED in ${root}:\n  ${v.problems.slice(0, 40).join("\n  ")}`);
        process.exit(1);
      }
      console.log(JSON.stringify({ verified: root, releaseId: v.manifest.releaseId, digest: v.manifest.digest, fileCount: v.manifest.fileCount }));
    } else {
      const id = computeIdentity(root);
      if (id.missing.length) throw new Error(`Runtime paths missing: ${id.missing.join(", ")}`);
      console.log(JSON.stringify({ releaseId: id.releaseId, digest: id.digest, fileCount: id.fileCount }));
    }
  } catch (e) {
    console.error(String(e.message ?? e));
    process.exit(1);
  }
}
