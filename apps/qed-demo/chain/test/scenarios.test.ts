/**
 * The six configurable scenarios (the release's runWorkbench, unmodified) at their input bounds, with the results
 * the release's own workbench test expects, and the historical evidence index.
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { homedir } from "node:os";
import { join } from "node:path";
import { startRail, type TestRail } from "./helpers.ts";
import { RailError } from "../rail/service.ts";

process.env.PATH = `${join(homedir(), ".foundry", "bin")}:${process.env.PATH}`;
let t: TestRail;
before(async () => { t = await startRail("scenarios", 18601); await t.ready(); });
after(async () => { await t.stop(); });
const refused = async (tool: string, parameters: unknown, code = "invalid_tool_input") => assert.rejects(() => t.rail.propose({ kind: "scenario", params: { tool, parameters } }), (e: unknown) => e instanceof RailError && e.code === code, `${tool} ${JSON.stringify(parameters)} should be refused`);
const accepted = async (tool: string, parameters: unknown) => assert.equal((await t.rail.propose({ kind: "scenario", params: { tool, parameters } })).allowed, true, `${tool} ${JSON.stringify(parameters)}`);

test("six scenarios are listed with their bounds; the zero-knowledge one is off by default and says why", () => {
  const list = t.rail.scenarios.list();
  // the release's six, then the rail's own time-moving scenario (R7 D4); every one runs on an ephemeral chain
  assert.deepEqual(list.map((s) => s.tool), ["portfolio", "private_portfolio", "clearing", "payment", "liability", "execution_bounty", "liability_due"]);
  assert.deepEqual(list.map((s) => s.available), [true, false, true, true, true, true, true]);
  assert.deepEqual(list.map((s) => [s.source, s.chain]), [...Array(6).fill(["release", "ephemeral"]), ["rail", "ephemeral"]]);
  assert.match(list[1].unavailableReason!, /GPL-3\.0.*owner decision F-052/);
  for (const s of list) assert.ok(s.bounds.length > 10 && s.schema && s.label);
});

test("input bounds are the release's: the value at each bound is accepted, one step outside is refused", async () => {
  const vols6 = [1, 100, 50, 8, 22, 12];
  await accepted("portfolio", { price: "25", volatilities: [1, 100] });
  await accepted("portfolio", { price: "0.000001", volatilities: vols6 });
  await refused("portfolio", { price: "25.000001", volatilities: [1, 100] });
  await refused("portfolio", { price: "0", volatilities: [1, 100] });
  await refused("portfolio", { price: "5", volatilities: [12] });
  await refused("portfolio", { price: "5", volatilities: [...vols6, 9] });
  await refused("portfolio", { price: "5", volatilities: [0.99, 10] });
  await refused("portfolio", { price: "5", volatilities: [10, 100.01] });
  await refused("portfolio", { price: 5, volatilities: [10, 20] });
  await refused("portfolio", { price: "5", volatilities: [10, 20], payee: "0x0000000000000000000000000000000000000001" });
  const six = ["A", "B", "C", "D", "E", "F"];
  const debts = (n: number, amount = "1") => Array.from({ length: n }, (_, i) => ({ from: six[i % 6], to: six[(i + 1) % 6], amount }));
  await accepted("clearing", { members: six, obligations: debts(16, "1000") });
  await accepted("clearing", { members: ["A", "B"], obligations: debts(1).map(() => ({ from: "A", to: "B", amount: "0.000001" })) });
  await refused("clearing", { members: [...six, "G"], obligations: debts(1) });
  await refused("clearing", { members: ["A"], obligations: [] });
  await refused("clearing", { members: ["A", "a"], obligations: [{ from: "A", to: "a", amount: "1" }] });
  await refused("clearing", { members: six, obligations: debts(17) });
  await refused("clearing", { members: six, obligations: debts(1, "1000.000001") });
  await refused("clearing", { members: ["A", "B"], obligations: [{ from: "A", to: "A", amount: "1" }] });
  await refused("clearing", { members: ["A", "B"], obligations: [{ from: "A", to: "Z", amount: "1" }] });
  await accepted("payment", { amount: "10" });
  await refused("payment", { amount: "10.000001" });
  await accepted("liability", { amount: "95" });
  await refused("liability", { amount: "95.000001" });
  await accepted("execution_bounty", { amount: "25" });
  await refused("execution_bounty", { amount: "25.000001" });
  for (const bad of ["-1", ".5", "1e1", "1,0"]) await refused("payment", { amount: bad });
  await refused("private_portfolio", { price: "4.25", volatilities: [8, 10, 12, 9, 30, 5] }, "zk_optional_disabled");
  await refused("shell", { cmd: "ls" }, "unsupported_scenario");
});

test("each scenario runs on real contracts with the results the release's own test expects, and never touches the main treasury", { timeout: 240_000 }, async () => {
  const main = async () => { const s = await t.rail.state(); return [s.treasury.balance, s.reserve.balance, s.treasury.spentInWindow]; };
  const initial = await main();
  const cases: [string, unknown, (ev: any, job: any) => void][] = [
    ["portfolio", { price: "7.123456", volatilities: [12, 8, 22] }, (ev) => { assert.equal(ev.providerBalance, "7123456"); assert.equal(ev.escrowBalance, "0"); assert.equal(ev.bounty.tx.error, "TheoremHolds"); }],
    ["portfolio", { price: "25", volatilities: [1, 100] }, (ev) => assert.equal(ev.providerBalance, "25000000")],
    ["clearing", { members: ["A", "B", "C"], obligations: [{ from: "A", to: "B", amount: "10.123456" }, { from: "B", to: "C", amount: "8.5" }, { from: "C", to: "A", amount: "7.25" }] }, (ev) => { assert.equal(ev.cleared, "21750000"); assert.equal(ev.open, "0"); }],
    ["payment", { amount: "3.123456" }, (ev) => { assert.equal(ev.creditorBalance, "3123456"); assert.equal(ev.replay.error, "IntentAlreadyUsed"); }],
    ["payment", { amount: "10" }, (ev) => assert.equal(ev.creditorBalance, "10000000")],
    ["liability", { amount: "70.123456" }, (ev) => { assert.equal(ev.creditorBalance, "70123456"); assert.equal(ev.paused, true); }],
    ["liability", { amount: "95" }, (ev) => assert.equal(ev.vaultBalance, "5000000")],
    ["execution_bounty", { amount: "10" }, (ev, job) => { assert.equal(job.result.tx.error, "TheoremHolds"); assert.equal(ev.pool, "10000000"); }],
    ["execution_bounty", { amount: "25" }, (ev) => assert.equal(ev.pool, "25000000")],
  ];
  for (const [tool, parameters, check] of cases) {
    const job = await t.act("scenario", { tool, parameters });
    assert.equal(job.status, "done", `${tool} ${JSON.stringify(parameters)}: ${job.error ?? ""}`);
    assert.equal(job.result!.outcome, tool === "execution_bounty" ? "reverted" : "executed", job.result!.summary);
    assert.match(job.result!.tx!.hash, /^0x[0-9a-f]{64}$/);
    assert.ok(job.steps.length >= 4 && job.steps[0].key === "chain" && job.steps[1].key === "owner", "the release's steps, on an ephemeral chain started first");
    const ev = job.result!.evidence as any;
    assert.equal(ev.mainTreasuryUnchanged, true);
    check(ev, job);
    assert.deepEqual(await main(), initial, `${tool}: main treasury unchanged`);
    const d = t.rail.decisions(5, job.id);
    assert.deepEqual([d[0].kind, d[0].verdict], ["owner-scenario", "CONFIRMED"]);
  }
  assert.ok((await t.rail.clock()).skewSeconds >= -5, "scenarios did not push the chain ahead of the wall clock");
});

test("historical evidence index: read-only, every row labelled HISTORICAL, the two key files excluded", () => {
  const ev = t.rail.scenarios.evidence();
  assert.equal(ev.label, "HISTORICAL");
  assert.match(ev.note, /^Historical: mined on the public Ethereum Sepolia testnet/);
  assert.deepEqual(ev.counts, { transactions: 161, reverted: 49, contracts: 24, inManifests: { transactions: 196, reverted: 49 } });
  assert.ok(ev.transactions.every((x) => x.label === "HISTORICAL" && /^0x[0-9a-f]{64}$/.test(x.hash)));
  assert.ok(ev.contracts.every((x) => x.label === "HISTORICAL"));
  assert.deepEqual([...new Set(ev.transactions.map((x) => x.run.slice(0, 5)))], ["Run 1", "Run 2", "Run 3", "Run 4"]);
  assert.equal(ev.excluded.length, 2);
  assert.ok(!JSON.stringify(ev).includes("PrivateKey"));
});
