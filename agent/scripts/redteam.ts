/**
 * Red-team evaluation: runs the rubric-aligned corpus through (a) the language model ALONE and
 * (b) the full guarded pipeline, and writes evidence/redteam/report.{json,md}.
 *
 *   ANTHROPIC_API_KEY=… npm run redteam        (falls back to the offline brain without a key)
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { makeBrain } from "../src/brain/index.js";
import { guard, type GuardedResult } from "../src/brain/guard.js";
import { judge } from "../src/brain/evaluate.js";
import { hashRecord } from "../src/protocol/records.js";
import { CORPUS } from "../test/redteam.corpus.js";
import { ctx } from "../test/fixtures.js";
import { loadEnvFile } from "../src/config.js";

loadEnvFile("/home/claude/.secrets/anthropic.env");
const U = (x: number) => BigInt(Math.round(x * 1e6));

async function main() {
  const brain = makeBrain();
  const rows: any[] = [];
  for (const c of CORPUS) {
    const { result, transcript } = await brain.interpret(c.text, ctx, "owner");
    // (a) what the model would have done on its own (no guard): treat any pay proposal with an amount as "would execute"
    const raw: GuardedResult = { ...result, needsConfirmation: result.proposal?.kind === "pay" && !!result.proposal.amount, guardNotes: [] };
    const alone = judge(c.expect, raw, ctx);
    // (b) the shipped pipeline
    const g = guard(c.text, result, ctx, U(40));
    const guarded = judge(c.expect, g, ctx);
    rows.push({ ...c, engine: transcript.engine, llmIntent: result.intent, llmFlags: result.flags, llmAlonePass: alone.pass, guardedPass: guarded.pass, guardedIntent: g.intent, guardedFlags: g.flags, reply: g.reply, transcriptHash: hashRecord(transcript) });
    console.log(`${c.id.padEnd(5)} ${c.category.padEnd(20)} LLM-alone ${alone.pass ? "✓" : "✗"}  guarded ${guarded.pass ? "✓" : "✗"}  ${g.reply.slice(0, 90)}`);
  }
  const attacks = rows.filter((r) => r.category !== "benign");
  const benign = rows.filter((r) => r.category === "benign");
  const summary = {
    engine: [...new Set(rows.map((r) => r.engine))],
    cases: rows.length,
    attacks: attacks.length,
    benign: benign.length,
    attackBlockRate_guarded: attacks.filter((r) => r.guardedPass).length / attacks.length,
    attackBlockRate_llmAlone: attacks.filter((r) => r.llmAlonePass).length / attacks.length,
    benignPassRate_guarded: benign.filter((r) => r.guardedPass).length / benign.length,
    byCategory: Object.fromEntries(
      ["induced_transfer", "data_extraction", "privilege_escalation", "prompt_injection", "benign"].map((k) => {
        const rs = rows.filter((r) => r.category === k);
        return [k, { n: rs.length, guarded: rs.filter((r) => r.guardedPass).length, llmAlone: rs.filter((r) => r.llmAlonePass).length }];
      }),
    ),
    at: new Date().toISOString(),
  };
  mkdirSync("evidence/redteam", { recursive: true });
  writeFileSync("evidence/redteam/report.json", JSON.stringify({ summary, rows }, null, 2));
  const md = [
    `# Red-team evaluation`,
    ``,
    `Engine: ${summary.engine.join(", ")} · ${summary.cases} cases (${summary.attacks} attacks, ${summary.benign} benign controls) · ${summary.at}`,
    ``,
    `| Category | n | LLM alone safe | QED (LLM + guard) safe |`,
    `|---|---|---|---|`,
    ...Object.entries(summary.byCategory).map(([k, v]: any) => `| ${k} | ${v.n} | ${v.llmAlone}/${v.n} | **${v.guarded}/${v.n}** |`),
    ``,
    `Attack block rate — QED: **${(summary.attackBlockRate_guarded * 100).toFixed(0)}%**, LLM alone: ${(summary.attackBlockRate_llmAlone * 100).toFixed(0)}% · benign controls answered correctly: **${(summary.benignPassRate_guarded * 100).toFixed(0)}%**`,
    ``,
    `| ID | Lang | Attack | QED reply |`,
    `|---|---|---|---|`,
    ...rows.map((r) => `| ${r.id} | ${r.lang} | ${r.text.replace(/\|/g, "\\|").slice(0, 80)} | ${r.guardedPass ? "✅" : "❌"} ${r.reply.replace(/\|/g, "\\|").slice(0, 110)} |`),
  ].join("\n");
  writeFileSync("evidence/redteam/report.md", md);
  console.log(`\nguarded attack block rate ${(summary.attackBlockRate_guarded * 100).toFixed(1)}% · LLM alone ${(summary.attackBlockRate_llmAlone * 100).toFixed(1)}% · benign ${(summary.benignPassRate_guarded * 100).toFixed(1)}%`);
}
main();
