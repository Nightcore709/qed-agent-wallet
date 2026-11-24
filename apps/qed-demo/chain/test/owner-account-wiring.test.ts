/**
 * The owner-account wiring (decision Q-B, 22 Nov 2026, taken by the R7 orchestrator; docs/r7/00-ARCHITECTURE-DECISIONS.md): the rail uses chain/accounts' QEDOwnerAccount build only
 * when chain/accounts/READY.json says {"status":"ready"} for out/QEDOwnerAccount.sol/QEDOwnerAccount.json and that
 * file's SHA-256 matches; otherwise it refuses to create a workspace, unless QED_RAIL_OWNER_ACCOUNT_BUILD=unreviewed
 * (tests only), which every view labels.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { getAddress } from "viem";
import { freshDir, startHost } from "./helpers.ts";
import { RP_ID_HASH, SoftwarePasskey } from "./passkey.ts";
import { ACCOUNT_ARTIFACT, ACCOUNT_FUNCTIONS, ACCOUNTS_DIR, READY_ARTIFACT, accountReadiness, loadAccountArtifact } from "../rail/owner.ts";
import { releaseGuards } from "../accounts/webauthn.ts";

process.env.PATH = `${join(homedir(), ".foundry", "bin")}:${process.env.PATH}`;
const sha = (p: string) => createHash("sha256").update(readFileSync(p)).digest("hex");

test("chain/accounts/READY.json declares the build: status ready, the artifact's SHA-256 matches, and every function the rail calls is in it", () => {
  const r = accountReadiness();
  assert.equal(r.declared, true, r.reason);
  assert.equal(r.artifactSha256, sha(ACCOUNT_ARTIFACT));
  assert.equal(r.solc, "0.8.38");
  const art = loadAccountArtifact("declared");
  assert.equal(art.sha256, r.artifactSha256);
  const names = new Set(art.abi.filter((x) => x.type === "function").map((x) => (x as { name: string }).name));
  for (const f of [...ACCOUNT_FUNCTIONS, "scheduleCalls", "applyCalls", "cancel", "cancelDigest", "getChange", "guardedCalls", "isGuarded"]) assert.ok(names.has(f), `the build has ${f}`);
});

test("an undeclared or mismatched build is refused: no READY.json, a status other than ready, another artifact, a wrong hash; unreviewed loads it and says so", () => {
  const dir = freshDir("accounts-copy");
  mkdirSync(join(dir, "out", "QEDOwnerAccount.sol"), { recursive: true });
  const artifact = join(dir, READY_ARTIFACT);
  copyFileSync(ACCOUNT_ARTIFACT, artifact);
  const ready = (o: Record<string, unknown>) => writeFileSync(join(dir, "READY.json"), JSON.stringify({ status: "ready", artifact: READY_ARTIFACT, artifactSha256: sha(artifact), solc: "0.8.38", date: "2026-11-22", ...o }));
  assert.match(accountReadiness(dir).reason, /READY\.json does not exist/);
  assert.throws(() => loadAccountArtifact("declared", artifact, dir), (e: { code: string; http: number }) => e.code === "owner_account_not_ready" && e.http === 503);
  ready({ status: "in-progress" });
  assert.match(accountReadiness(dir).reason, /status "in-progress"/);
  ready({ artifact: "out/Other.json" });
  assert.match(accountReadiness(dir).reason, /names "out\/Other\.json"/);
  ready({ artifactSha256: "0".repeat(64) });
  assert.match(accountReadiness(dir).reason, /SHA-256 is [0-9a-f]{64}, but chain\/accounts\/READY\.json states/);
  assert.throws(() => loadAccountArtifact("declared", artifact, dir), (e: { code: string }) => e.code === "owner_account_not_ready");
  const unreviewed = loadAccountArtifact("unreviewed", artifact, dir);
  assert.equal(unreviewed.readiness.declared, false, "unreviewed loads the build but records that it was not declared");
  ready({});
  assert.equal(accountReadiness(dir).declared, true);
  assert.equal(ACCOUNTS_DIR.endsWith(join("chain", "accounts")), true);
});

test("a workspace records the declared build it was deployed from, and its owner account holds exactly chain/accounts' releaseGuards", { timeout: 120_000 }, async () => {
  const port = Number(process.env.QED_TEST_ANVIL_PORT ?? 18753);
  const h = await startHost("wiring", port, { economyAnvilPort: port + 1 });
  try {
    const v = await h.host.createWorkspace({ workspaceId: "wired-one", owner: new SoftwarePasskey().publicKey, rpIdHash: RP_ID_HASH });
    assert.equal(v.ownerAccountBuild?.declaredReady, true);
    assert.equal(v.ownerAccountBuild?.sha256, accountReadiness().artifactSha256);
    assert.match(v.ownerAccountBuild!.label, /^declared ready by chain\/accounts\/READY\.json/);
    const ws = h.host.workspace("wired-one")!;
    const abi = JSON.parse(readFileSync(ACCOUNT_ARTIFACT, "utf8")).abi;
    const onChain = (await ws.read(ws.a.ownerAccount!, abi, "guardedCalls")) as { target: string; selector: string }[];
    const want = [...releaseGuards({ vault: ws.a.vault, execution: ws.a.exec, policy: ws.a.treasuryPolicy! }), ...releaseGuards({ vault: ws.a.reserve })];
    assert.deepEqual(onChain.map((g) => [getAddress(g.target), g.selector.toLowerCase()]), want.map((g) => [getAddress(g.target), g.selector.toLowerCase()]));
  } finally { await h.stop(); }
});
