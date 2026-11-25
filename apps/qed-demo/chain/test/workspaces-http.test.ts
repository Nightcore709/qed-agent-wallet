/**
 * The multi-tenant HTTP contract, on the real service process (node serve.ts, the co-signer in its own process).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { key } from "./helpers.ts";
import { startService, type Service } from "./service-helper.ts";
import { RP_ID_HASH, SoftwarePasskey, passkeyApproval } from "./passkey.ts";
import type { Accepted, Job, Proposal, RailState, WorkspaceView } from "../types.ts";

const env = { QED_RAIL_MODE: "multi-tenant", QED_RAIL_GLOBAL_QUOTA_WORKSPACES: "2", QED_RAIL_ACCOUNT_DELAY_S: "60", QED_RAIL_ACCOUNT_RECOVERY_DELAY_S: "60" };

async function act(s: Service, ws: string, kind: string, params: Record<string, unknown>, signers: SoftwarePasskey[]): Promise<Job> {
  const p = await s.call<Proposal>("POST", `/workspaces/${ws}/proposals`, { kind, params });
  assert.equal(p.status, 201, JSON.stringify(p.data));
  const a = await s.call<Accepted>("POST", `/workspaces/${ws}/proposals/${p.data.id}/execute`, { approval: passkeyApproval(p.data, signers) }, { "Idempotency-Key": key() });
  assert.equal(a.status, 202, JSON.stringify(a.data));
  assert.equal(a.headers.get("location"), `/workspaces/${ws}/jobs/${a.data.jobId}`);
  for (let i = 0; i < 600; i++) {
    const j = (await s.call<Job>("GET", `/workspaces/${ws}/jobs/${a.data.jobId}`)).data;
    if (["done", "failed", "interrupted"].includes(j.status)) return j;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error("job did not finish");
}

test("over HTTP: POST /workspaces, routes under /workspaces/:id, an unknown workspace 404 after the token, cross-workspace identifiers find nothing, scheduled changes, the host's budget, and a restart", { timeout: 240_000 }, async () => {
  const s = await startService("svc-workspaces", 15190, 18755, { env, workspace: null });
  const alice = new SoftwarePasskey(), bob = new SoftwarePasskey();
  let dir = s.dir, stopped = false;
  try {
    const h = (await s.call("GET", "/health")).data;
    assert.deepEqual([h.ready, h.mode, h.workspaces], [true, "multi-tenant", 0]);
    // creation: idempotent by workspaceId; another owner under the same id is refused; malformed input is refused
    const created = await s.call<WorkspaceView>("POST", "/workspaces", { workspaceId: "alice-home", owner: alice.publicKey, rpIdHash: RP_ID_HASH });
    assert.equal(created.status, 201, JSON.stringify(created.data));
    assert.deepEqual([created.data.ownerKind, created.data.status, created.data.grant], ["passkey-account", "awaiting-acceptance", null]);
    const again = await s.call<WorkspaceView>("POST", "/workspaces", { workspaceId: "alice-home", owner: alice.publicKey, rpIdHash: RP_ID_HASH });
    assert.deepEqual([again.status, again.data.duplicate, again.data.ownerAccount], [200, true, created.data.ownerAccount]);
    assert.equal((await s.call("POST", "/workspaces", { workspaceId: "alice-home", owner: bob.publicKey, rpIdHash: RP_ID_HASH })).data.error.code, "workspace_exists");
    for (const bad of [{}, { workspaceId: "Alice!", owner: alice.publicKey, rpIdHash: RP_ID_HASH }, { workspaceId: "x-one", owner: { x: "0x01", y: "0x02" }, rpIdHash: RP_ID_HASH }, { workspaceId: "x-two", owner: alice.publicKey, rpIdHash: "0x00" }, { workspaceId: "baseline", owner: alice.publicKey, rpIdHash: RP_ID_HASH }]) {
      const r = await s.call("POST", "/workspaces", bad);
      assert.deepEqual([r.status, r.data.error.code], [422, "invalid_workspace"], JSON.stringify(bad));
    }
    assert.equal((await s.call("POST", "/workspaces", { workspaceId: "bob-shop", owner: bob.publicKey, rpIdHash: RP_ID_HASH })).status, 201);
    const third = await s.call("POST", "/workspaces", { workspaceId: "carol-co", owner: new SoftwarePasskey().publicKey, rpIdHash: RP_ID_HASH });
    assert.deepEqual([third.status, third.data.error.code, third.data.error.details.scope, third.data.error.details.class], [429, "quota_exceeded", "global", "workspaces"]);
    assert.ok(Number(third.headers.get("retry-after")) > 0);
    // routes: an unknown workspace is 404, and only after the token was checked
    assert.equal((await fetch(`http://127.0.0.1:${s.port}/workspaces/nobody-here/state`)).status, 401);
    assert.deepEqual([(await s.call("GET", "/workspaces/nobody-here/state")).status, (await s.call("GET", "/workspaces/nobody-here/state")).data.error.code], [404, "unknown_workspace"]);
    assert.equal((await s.call("GET", "/state")).status, 404, "there is no route outside a workspace any more");
    const view = (await s.call<WorkspaceView>("GET", "/workspaces/alice-home")).data;
    assert.equal(view.contracts.ownerAccount, created.data.ownerAccount);
    // the owner's passkey accepts the vault set over HTTP; the grant follows
    const prov = await act(s, "alice-home", "provision", {}, [alice]);
    assert.equal(prov.result?.outcome, "executed", prov.error ?? "");
    const st = (await s.call<RailState>("GET", "/workspaces/alice-home/state")).data;
    assert.deepEqual([st.provisioned, st.workspace.status, st.treasury.token, st.treasury.balance, st.roles.owner, st.roles.cosignerIsolation], [true, "ready", "tINR", "10000000", created.data.ownerAccount, "separate-process"]);
    assert.equal((await act(s, "bob-shop", "provision", {}, [bob])).result?.outcome, "executed");
    // alice's identifiers find nothing in bob's workspace
    const tx = prov.result!.tx!.hash;
    for (const path of [`/proposals/${prov.proposalId}`, `/jobs/${prov.id}`, `/receipts/${tx}`]) {
      const r = await s.call("GET", `/workspaces/bob-shop${path}`);
      assert.equal(r.status, 404, `${path}: ${JSON.stringify(r.data)}`);
    }
    assert.equal((await s.call("GET", `/workspaces/alice-home/receipts/${tx}`)).status, 200);
    assert.deepEqual((await s.call("GET", `/workspaces/bob-shop/decisions?jobId=${prov.id}`)).data.decisions, []);
    // a guarded change is scheduled; the list shows it; applying it before the delay is refused
    const rot = await act(s, "alice-home", "rotate-key", { role: "operator" }, [alice]);
    assert.equal(rot.result?.outcome, "scheduled", rot.error ?? "");
    const sch = (await s.call("GET", "/workspaces/alice-home/scheduled")).data.scheduled;
    assert.deepEqual(sch.map((x: { kind: string; status: string }) => [x.kind, x.status]), [["rotate-key", "pending"]]);
    assert.deepEqual((await s.call("GET", "/workspaces/bob-shop/scheduled")).data.scheduled, []);
    const ap = await s.call<Accepted>("POST", `/workspaces/alice-home/scheduled/${sch[0].changeId}/apply`, {}, { "Idempotency-Key": key() });
    assert.equal(ap.status, 202);
    let j: Job;
    for (;;) { j = (await s.call<Job>("GET", `/workspaces/alice-home/jobs/${ap.data.jobId}`)).data; if (j.status !== "accepted" && j.status !== "running") break; await new Promise((r) => setTimeout(r, 100)); }
    assert.equal(j.result?.outcome, "refused", "not before the owner account's delay");
    assert.equal((await s.call("POST", `/workspaces/bob-shop/scheduled/${sch[0].changeId}/apply`, {}, { "Idempotency-Key": key() })).data.error.code, "unknown_change");
    // the host's budget over all workspaces
    const q = (await s.call("GET", "/quota")).data;
    assert.equal(q.classes.find((c: { class: string }) => c.class === "workspaces").used, 2);
    // a restart: both workspaces, their states and the pending change are back
    const before = { a: (await s.call<RailState>("GET", "/workspaces/alice-home/state")).data, b: (await s.call<RailState>("GET", "/workspaces/bob-shop/state")).data };
    assert.equal(await s.stop(), 0);
    stopped = true;
    const s2 = await startService("svc-workspaces", 15190, 18755, { env, workspace: null, dir });
    try {
      for (const [ws, b] of [["alice-home", before.a], ["bob-shop", before.b]] as const) {
        const now = (await s2.call<RailState>("GET", `/workspaces/${ws}/state`)).data;
        assert.deepEqual([now.treasury.balance, now.reserve.balance, now.roles.owner, now.provisioned, now.restoredFromState], [b.treasury.balance, b.reserve.balance, b.roles.owner, true, true]);
      }
      assert.equal((await s2.call("GET", "/workspaces/alice-home/scheduled")).data.scheduled[0].status, "pending");
      assert.equal((await act(s2, "bob-shop", "pause", {}, [bob])).result?.outcome, "executed", "bob's passkey still works after the restart");
    } finally { await s2.stop(); }
  } finally { if (!stopped) await s.stop(); rmSync(dir, { recursive: true, force: true }); }
});

test("killed in the middle of creating a workspace: the restart completes it at the same addresses, and the same request then answers it as a duplicate", { timeout: 240_000 }, async () => {
  const alice = new SoftwarePasskey();
  const body = { workspaceId: "crash-home", owner: alice.publicKey, rpIdHash: RP_ID_HASH };
  const first = await startService("svc-crash-create", 15191, 18757, { env: { ...env, QED_RAIL_ALLOW_FAULTS: "1", QED_RAIL_FAULT: "mid-provision" }, workspace: null });
  const dir = first.dir;
  try {
    await first.call("POST", "/workspaces", body).catch(() => null); // the process dies while deploying
    await first.until(async () => first.child.exitCode !== null || first.child.signalCode !== null, 20_000, "the kill");
    first.reapAnvil();
    const s = await startService("svc-crash-create", 15191, 18757, { env, workspace: null, dir });
    try {
      const v = (await s.call<WorkspaceView>("GET", "/workspaces/crash-home")).data;
      assert.deepEqual([v.status, v.grant], ["awaiting-acceptance", null], JSON.stringify(v).slice(0, 300));
      const again = await s.call<WorkspaceView>("POST", "/workspaces", body);
      assert.deepEqual([again.status, again.data.duplicate, again.data.contracts.vault], [200, true, v.contracts.vault]);
      const st = (await s.call<RailState>("GET", "/workspaces/crash-home/state")).data;
      assert.equal(st.treasury.balance, "0", "nothing arrived before acceptance");
      assert.equal((await act(s, "crash-home", "provision", {}, [alice])).result?.outcome, "executed", "the completed workspace is accepted and works");
    } finally { await s.stop(); }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

/**
 * R14 (the production failure of 25 Nov 2026). A creation that stops after the registry has recorded the workspace's
 * contracts and before the chain was saved leaves a registry that names contracts the saved chain does not hold. On the
 * deployed image that happened to every set-up (the co-signer could not be configured), and the next start then failed
 * for everyone ("the contract function cosigner returned no data"): one unfinished workspace stopped the wallet service.
 * Such a workspace is completed at start, like one stopped earlier; and another household's finished wallet is untouched.
 */
test("killed after a workspace's contracts were recorded and before the chain was saved: the restart completes it, the service is ready, and a finished workspace still works", { timeout: 300_000 }, async () => {
  const P = Number(process.env.QED_CHAIN_TEST_PORT ?? 15195);
  const more = { ...env, QED_RAIL_ECONOMY_ANVIL_PORT: String(P + 2) };
  const alice = new SoftwarePasskey(), bob = new SoftwarePasskey();
  const body = { workspaceId: "late-crash-home", owner: alice.publicKey, rpIdHash: RP_ID_HASH };
  const first = await startService("svc-crash-recorded", P, P + 1, { env: more, workspace: null });
  const dir = first.dir;
  try {
    // a finished wallet first, with money in it
    assert.equal((await first.call("POST", "/workspaces", { workspaceId: "bob-home", owner: bob.publicKey, rpIdHash: RP_ID_HASH })).status, 201);
    assert.equal((await act(first, "bob-home", "provision", {}, [bob])).result?.outcome, "executed");
    const bobBefore = (await first.call<RailState>("GET", "/workspaces/bob-home/state")).data.treasury.balance;
    assert.equal(await first.stop(), 0);
    const second = await startService("svc-crash-recorded", P, P + 1, { env: { ...more, QED_RAIL_ALLOW_FAULTS: "1", QED_RAIL_FAULT: "provision-recorded" }, workspace: null, dir });
    await second.call("POST", "/workspaces", body).catch(() => null); // the process dies with the contracts recorded and the chain not saved
    await second.until(async () => second.child.exitCode !== null || second.child.signalCode !== null, 20_000, "the kill");
    second.reapAnvil();
    const s = await startService("svc-crash-recorded", P, P + 1, { env: more, workspace: null, dir });
    try {
      assert.equal((await s.call<{ ready: boolean }>("GET", "/health")).data.ready, true, s.log().slice(-600));
      const v = (await s.call<WorkspaceView>("GET", "/workspaces/late-crash-home")).data;
      assert.deepEqual([v.status, v.grant], ["awaiting-acceptance", null], JSON.stringify(v).slice(0, 300));
      const again = await s.call<WorkspaceView>("POST", "/workspaces", body);
      assert.deepEqual([again.status, again.data.duplicate, again.data.contracts.vault], [200, true, v.contracts.vault]);
      assert.equal((await act(s, "late-crash-home", "provision", {}, [alice])).result?.outcome, "executed", "the completed workspace is accepted and works");
      // the other household's wallet: the same money, and it still acts
      assert.equal((await s.call<RailState>("GET", "/workspaces/bob-home/state")).data.treasury.balance, bobBefore);
      assert.equal((await act(s, "bob-home", "mandate", { maxPerPayment: "100" }, [bob])).result?.outcome, "executed");
    } finally { await s.stop(); }
  } finally { await first.stop().catch(() => undefined); rmSync(dir, { recursive: true, force: true }); }
});
