/**
 * First parity gate: runs the release's own suites in a disposable copy of the vendored tree.
 *
 *   node scripts/parity-gate.mjs --tier default|full [--node <path to a node binary>] [--only a,b] [--skip a,b]
 *
 * The eight labels and their commands are those of the release's RUN_FULL_LOCAL_QA.sh (saved result for
 * Node v22.23.3: 305 tests in ~/qed-approved-release/review/deploy-20261025/qa-node22/SUMMARY.txt). Deviations are
 * limited to which test FILES are run, are listed in NOT_RUN below, and are written into every result file:
 * no test is edited and no assertion is weakened. Node suites are run one file at a time so that every file has its
 * own count; `node --test` isolates files in separate processes anyway.
 *
 *   default  the committed tree (vendor/): no GPL-3.0 source, no GPL-3.0 package
 *   full     vendor/ plus the zk-optional tier (must have been enabled; see zk-optional/README.md)
 *
 * Everything runs locally: Anvil on 127.0.0.1, development keys, QED_OFFLINE=1 and no model key, so no external
 * call is made. Raw output is saved under results/gate/<tier>-node<version>/ and a summary beside it.
 */
import { spawn, execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { assembleTree } from "./assemble-tree.mjs";

const PKG = resolve(fileURLToPath(new URL("..", import.meta.url)));
const args = process.argv.slice(2);
const arg = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
const TIER = arg("--tier") ?? "default";
if (!["default", "full"].includes(TIER)) { console.error("--tier must be default or full"); process.exit(2); }
const NODE = resolve(arg("--node") ?? process.execPath);
const only = arg("--only")?.split(",");
const skip = new Set(arg("--skip")?.split(",") ?? []);
const SOLC = "0.8.26";

/** Files of the release's suites that are not run here, with the reason. Nothing else is left out. */
const NOT_RUN = {
  "agent/test/deploy-script.test.mjs": { tests: 7, label: "focused-ui", tiers: ["default", "full"], reason: "Asserts the old Railway deployment script; the test and its inputs are not vendored (hosting is a separately approved phase)." },
  "agent/test/health-gate.integration.mjs": { tests: 3, label: "live-local-sandbox", tiers: ["default", "full"], reason: "Starts the release server in public mode, which binds every network interface (0.0.0.0). This workspace runs loopback only; running it needs the owner's go-ahead (F-071)." },
  "agent/test/release-identity.test.mjs": { tests: 4, label: "focused-ui", tiers: ["default"], reason: "Needs the release's complete runtime file set, including the circuit artefacts of the zk-optional tier. Run in the full tier." },
  "agent/test/private.test.ts": { tests: 5, label: "typescript-tests", tiers: ["default"], reason: "Imports the GPL-3.0-linked prover (zk-optional tier). Run in the full tier." },
  "agent/test/workbench.integration.mjs": { tests: 7, label: "workbench", tiers: ["default"], reason: "Statically imports the GPL-3.0-linked prover and runs the Groth16 scenario (zk-optional tier). Run in the full tier." },
  "contracts/test/PrivateMinVarianceVerifier.t.sol": { tests: 11, label: "solidity", tiers: ["default"], reason: "Imports the GPL-3.0 Groth16Verifier.sol (zk-optional tier). Run in the full tier." },
  "tsc --noEmit -p .": { tests: 0, label: "types", tiers: ["default"], reason: "The release's type check covers workbench.ts, whose dynamic import of the prover cannot resolve without the zk-optional tier. Run in the full tier." },
};
const notRun = (f) => NOT_RUN[f] && NOT_RUN[f].tiers.includes(TIER);

const FOCUSED_UI = ["ui-contract", "submission-tracker", "amount-parsing", "knowledge-and-interaction", "final-polish", "agent-scrolling-regression", "release-identity", "deploy-script", "readiness"].map((n) => `agent/test/${n}.test.mjs`);
const OLD_PAGE = new Set(["agent/test/ui-contract.test.mjs", "agent/test/final-polish.test.mjs", "agent/test/agent-scrolling-regression.test.mjs"]);
const LIVE = ["sandbox.integration", "demo.integration", "sandbox-clock.integration", "local-runner.integration", "health-gate.integration"].map((n) => `agent/test/${n}.mjs`);
const LIVE_PORTS = [14273, 14274, 14291, 18645, 18746, 18781, 18782, 18791, 18691, 18693, 18694, 7701, 7702, 7703];

const treeDir = TIER === "full" ? join(PKG, "zk-optional", ".build", "parity-full") : join(PKG, ".build", "parity-default");
const nodeVersion = execFileSync(NODE, ["--version"]).toString().trim();
const outDir = join(PKG, "results", "gate", `${TIER}-node${nodeVersion.replace(/^v/, "")}`);

const env = { ...process.env };
for (const k of Object.keys(env)) if (k.endsWith("_PK") || k.endsWith("_ADDR") || ["ANTHROPIC_API_KEY", "RPC_URL", "CHAIN_ID", "SHADOW", "SHADOW_OF", "START_STATE", "EXTRA_KEYS", "KEYS_FILE", "GAS_LIMIT", "NODE_OPTIONS", "QED_PUBLIC_DEMO"].includes(k)) delete env[k];
env.PATH = `${join(homedir(), ".foundry", "bin")}:${dirname(NODE)}:${env.PATH}`;
env.QED_OFFLINE = "1";
env.SOLC_VERSION = SOLC;
env.FOUNDRY_OFFLINE = "true"; // never download a compiler; solc 0.8.26 must already be installed
env.FORCE_COLOR = "0";
env.NO_COLOR = "1";

const scrub = (text) => text.split(treeDir).join("<tree>").split(PKG).join("<chain>").split(homedir()).join("~");

function run(cmd, argv, { timeoutMs }) {
  return new Promise((done) => {
    const started = Date.now();
    const child = spawn(cmd, argv, { cwd: treeDir, env, stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (out += d));
    const timer = setTimeout(() => { out += `\n[gate] timed out after ${timeoutMs} ms; killed\n`; child.kill("SIGKILL"); }, timeoutMs);
    child.on("error", (e) => { clearTimeout(timer); done({ code: -1, out: out + `\n[gate] could not start: ${e.message}\n`, ms: Date.now() - started }); });
    child.on("exit", (code, signal) => { clearTimeout(timer); done({ code: code ?? (signal ? 128 : -1), signal, out, ms: Date.now() - started }); });
  });
}

function parseNodeTest(out) {
  const pick = (k) => { const m = out.match(new RegExp(`^(?:#|ℹ) ${k} (\\d+)`, "m")); return m ? Number(m[1]) : null; };
  const failures = [...out.matchAll(/^\s*not ok \d+ - (.+)$/gm)].map((m) => m[1].trim());
  for (const m of out.matchAll(/^\s*✖ (.+?)(?: \(\d+(?:\.\d+)?ms\))?$/gm)) if (!failures.includes(m[1].trim())) failures.push(m[1].trim());
  return { tests: pick("tests"), pass: pick("pass"), fail: pick("fail"), cancelled: pick("cancelled"), skipped: pick("skipped"), todo: pick("todo"), failures };
}
function parseForge(out) {
  const total = out.match(/Ran \d+ test suites? in [^:]+: (\d+) tests passed, (\d+) failed, (\d+) skipped \((\d+) total tests\)/);
  const suites = [...out.matchAll(/Ran (\d+) tests? for ([^\n]+)\n(?:[\s\S]*?)Suite result: (\w+)\. (\d+) passed; (\d+) failed; (\d+) skipped/g)].map((m) => ({ suite: m[2].trim(), result: m[3], passed: Number(m[4]), failed: Number(m[5]), skipped: Number(m[6]) }));
  const failures = [...out.matchAll(/^\[FAIL[^\]]*\] (\S+)/gm)].map((m) => m[1]);
  return total ? { tests: Number(total[4]), pass: Number(total[1]), fail: Number(total[2]), skipped: Number(total[3]), suites, failures } : { tests: null, pass: null, fail: null, skipped: null, suites, failures };
}
const portFree = (port) => new Promise((ok) => {
  const s = createServer();
  s.once("error", () => ok(false));
  s.listen(port, "127.0.0.1", () => s.close(() => ok(true)));
});
/** After a live suite, stop any Anvil it left on one of its own ports (a failed test can orphan one). */
function reapAnvil() {
  const killed = [];
  for (const port of LIVE_PORTS) {
    let pids = [];
    try { pids = execFileSync("lsof", ["-nP", `-iTCP:${port}`, "-sTCP:LISTEN", "-t"]).toString().trim().split("\n").filter(Boolean); } catch { /* nothing listening */ }
    for (const pid of pids) {
      let comm = "";
      try { comm = execFileSync("ps", ["-p", pid, "-o", "comm="]).toString().trim(); } catch { /* gone */ }
      if (/anvil$/.test(comm)) { try { process.kill(Number(pid), "SIGKILL"); killed.push(`${port}:${pid}`); } catch { /* gone */ } }
    }
  }
  return killed;
}

const nodeSuite = (label, releaseCommand, releaseTests, nodeArgs, files, timeoutMs) => ({ kind: "node", label, releaseCommand, releaseTests, nodeArgs, files, timeoutMs });
const suites = [
  nodeSuite("focused-ui", "node --test " + FOCUSED_UI.join(" "), 62, ["--test"], FOCUSED_UI, 120_000),
  { kind: "tsc", label: "types", releaseCommand: "tsc --noEmit -p .", releaseTests: null, timeoutMs: 300_000 },
  nodeSuite("typescript-tests", "node --import tsx --test agent/test/*.test.ts", 64, ["--import", "tsx", "--test"], "glob:agent/test/*.test.ts", 300_000),
  { kind: "forge", label: "solidity", releaseCommand: "forge test", releaseTests: 147, timeoutMs: 1_500_000 },
  nodeSuite("backend-unit", "node --import tsx --test agent/test/demo.test.mjs", 8, ["--import", "tsx", "--test"], ["agent/test/demo.test.mjs"], 120_000),
  nodeSuite("live-local-sandbox", "node --import tsx --test --test-concurrency=1 " + LIVE.join(" "), 10, ["--import", "tsx", "--test", "--test-concurrency=1"], LIVE, 900_000),
  nodeSuite("workbench", "node --import tsx --test agent/test/capabilities.test.mjs agent/test/workbench.integration.mjs", 10, ["--import", "tsx", "--test"], ["agent/test/capabilities.test.mjs", "agent/test/workbench.integration.mjs"], 600_000),
  nodeSuite("release-safety", "node --experimental-strip-types --test agent/test/release-safety.test.mjs", 4, ["--experimental-strip-types", "--test"], ["agent/test/release-safety.test.mjs"], 120_000),
];

async function main() {
  const tree = assembleTree({ dest: treeDir, withZk: TIER === "full" });
  rmSync(outDir, { recursive: true, force: true });
  mkdirSync(outDir, { recursive: true });
  const versions = {
    node: nodeVersion,
    forge: execFileSync("forge", ["--version"], { env }).toString().split("\n")[0].trim(),
    anvil: execFileSync("anvil", ["--version"], { env }).toString().split("\n")[0].trim(),
    solc: SOLC,
  };
  console.log(`parity gate · tier ${TIER} · ${tree.files} files · Node ${versions.node} · ${versions.anvil}`);
  const result = { schema: "qed.chain-rail.parity-gate/v1", tier: TIER, startedAt: new Date().toISOString(), versions, tree: { files: tree.files, withZk: tree.withZk }, environment: { QED_OFFLINE: "1", ANTHROPIC_API_KEY: "(unset)", SOLC_VERSION: SOLC, FOUNDRY_OFFLINE: "true" }, suites: [], notRun: [] };
  for (const [f, n] of Object.entries(NOT_RUN)) if (n.tiers.includes(TIER)) result.notRun.push({ file: f, label: n.label, releaseTests: n.tests, reason: n.reason });

  for (const s of suites) {
    if (only && !only.includes(s.label)) continue;
    if (skip.has(s.label)) continue;
    const entry = { label: s.label, releaseCommand: s.releaseCommand, releaseTests: s.releaseTests, runs: [], tests: 0, pass: 0, fail: 0, skipped: 0, cancelled: 0, ok: true };
    process.stdout.write(`\n${s.label}\n`);
    if (s.kind === "forge") {
      const r = await run("forge", ["test"], { timeoutMs: s.timeoutMs });
      writeFileSync(join(outDir, `${s.label}.txt`), scrub(r.out));
      const p = parseForge(r.out);
      entry.runs.push({ command: `SOLC_VERSION=${SOLC} forge test`, exit: r.code, seconds: Math.round(r.ms / 1000), tests: p.tests, pass: p.pass, fail: p.fail, skipped: p.skipped, suites: p.suites, failures: p.failures });
      entry.tests = p.tests ?? 0; entry.pass = p.pass ?? 0; entry.fail = p.fail ?? 0; entry.skipped = p.skipped ?? 0;
      entry.ok = r.code === 0 && p.tests !== null && p.fail === 0;
      console.log(`  forge test: ${p.pass}/${p.tests} passed, ${p.fail} failed, exit ${r.code}, ${Math.round(r.ms / 1000)} s`);
    } else if (s.kind === "tsc") {
      if (notRun("tsc --noEmit -p .")) { entry.ok = null; entry.note = NOT_RUN["tsc --noEmit -p ."].reason; console.log("  not run in this tier"); }
      else {
        const r = await run(join(PKG, "node_modules", ".bin", "tsc"), ["--noEmit", "-p", "."], { timeoutMs: s.timeoutMs });
        writeFileSync(join(outDir, `${s.label}.txt`), scrub(r.out));
        const errors = (r.out.match(/error TS\d+/g) ?? []).length;
        entry.runs.push({ command: "tsc --noEmit -p .", exit: r.code, seconds: Math.round(r.ms / 1000), errors });
        entry.ok = r.code === 0;
        console.log(`  tsc: ${errors} errors, exit ${r.code}`);
      }
    } else {
      let files = s.files;
      if (typeof files === "string") files = readdirSync(join(treeDir, "agent/test")).filter((f) => f.endsWith(".test.ts")).sort().map((f) => `agent/test/${f}`);
      for (const f of files) {
        if (notRun(f) || !existsSync(join(treeDir, f))) {
          const why = NOT_RUN[f]?.reason ?? "file not in this tree";
          entry.runs.push({ file: f, notRun: true, reason: why });
          console.log(`  ${f}: not run`);
          continue;
        }
        if (s.label === "live-local-sandbox" || f.endsWith("workbench.integration.mjs")) {
          const busy = [];
          for (const port of [...LIVE_PORTS, 18765]) if (!(await portFree(port))) busy.push(port);
          if (busy.length) {
            entry.runs.push({ file: f, blocked: true, reason: `port(s) in use before the run: ${busy.join(", ")}` });
            entry.ok = false;
            console.log(`  ${f}: BLOCKED, ports in use: ${busy.join(", ")}`);
            continue;
          }
        }
        const r = await run(NODE, [...s.nodeArgs, f], { timeoutMs: s.timeoutMs });
        const name = `${s.label}__${f.split("/").pop()}.txt`;
        writeFileSync(join(outDir, name), scrub(r.out));
        const p = parseNodeTest(r.out);
        const reaped = s.label === "live-local-sandbox" || f.endsWith("workbench.integration.mjs") ? reapAnvil() : [];
        entry.runs.push({ file: f, command: `node ${s.nodeArgs.join(" ")} ${f}`, exit: r.code, seconds: Math.round(r.ms / 1000), ...p, oldPageMarkup: OLD_PAGE.has(f) || undefined, orphanedAnvilStopped: reaped.length ? reaped : undefined, output: name });
        entry.tests += p.tests ?? 0; entry.pass += p.pass ?? 0; entry.fail += p.fail ?? 0; entry.skipped += p.skipped ?? 0; entry.cancelled += p.cancelled ?? 0;
        if (r.code !== 0 || p.tests === null || p.fail !== 0 || p.cancelled) entry.ok = false;
        console.log(`  ${f}: ${p.pass}/${p.tests} passed, ${p.fail} failed, exit ${r.code}, ${Math.round(r.ms / 1000)} s`);
      }
    }
    result.suites.push(entry);
  }
  result.finishedAt = new Date().toISOString();
  const counted = result.suites.filter((s) => s.releaseTests !== null);
  result.totals = {
    tests: counted.reduce((a, s) => a + s.tests, 0),
    pass: counted.reduce((a, s) => a + s.pass, 0),
    fail: counted.reduce((a, s) => a + s.fail, 0),
    releaseTestsForTheseLabels: counted.reduce((a, s) => a + s.releaseTests, 0),
    releaseTestsNotRunHere: result.notRun.filter((n) => counted.some((s) => s.label === n.label)).reduce((a, n) => a + n.releaseTests, 0),
    allRunSuitesPassed: result.suites.every((s) => s.ok !== false),
  };
  writeFileSync(join(outDir, "summary.json"), JSON.stringify(result, null, 1) + "\n");
  console.log(`\n${result.totals.pass}/${result.totals.tests} passed, ${result.totals.fail} failed (release: ${result.totals.releaseTestsForTheseLabels} for these labels; ${result.totals.releaseTestsNotRunHere} not run here)`);
  console.log(`summary: ${scrub(join(outDir, "summary.json"))}`);
  process.exit(result.totals.allRunSuitesPassed ? 0 : 1);
}
main().catch((e) => { console.error(`gate error: ${e.message}`); process.exit(2); });
