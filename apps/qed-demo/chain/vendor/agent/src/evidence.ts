/**
 * Evidence recorder. Every on-chain step is written with the claim it supports, the actor and role
 * that signed it, the expected outcome, and the decoded events or custom error. `npm run verify`
 * later re-derives every one of these facts from a public RPC with no keys.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import type { Address, Hex } from "viem";
import type { TxResult } from "./chain.js";

export type Outcome = "O1" | "O2" | "O3" | "O4";

export interface Step {
  id: string;
  phase: string;
  title: string;
  narrative: string;
  actor: string; // role label
  actorAddress: Address;
  outcomes: Outcome[];
  expect: "success" | "revert";
  tx?: {
    hash: Hex;
    status: "success" | "reverted";
    blockNumber: string;
    gasUsed: string;
    from: Address;
    to: Address | null;
  };
  events?: { name: string; address: Address; args: Record<string, unknown> }[];
  error?: { name: string; args: unknown[] };
  attack?: { class: string; threat: string; defence: string; layer: string };
  artifacts?: { label: string; path: string; hash?: Hex }[];
  offchain?: boolean;
  at: string;
}

const norm = (x: unknown): unknown =>
  JSON.parse(JSON.stringify(x, (_, v) => (typeof v === "bigint" ? v.toString() : v)));

export class Evidence {
  readonly steps: Step[] = [];
  meta: Record<string, unknown> = {};
  constructor(private dir: string) {
    mkdirSync(dir, { recursive: true });
  }

  tx(
    id: string,
    s: Omit<Step, "id" | "tx" | "events" | "error" | "at" | "actorAddress" | "expect"> & { expect?: "success" | "revert" },
    r: TxResult,
  ): TxResult {
    const step: Step = {
      ...s,
      id,
      expect: s.expect ?? (r.status === "success" ? "success" : "revert"),
      actorAddress: r.from,
      tx: { hash: r.hash, status: r.status, blockNumber: r.blockNumber.toString(), gasUsed: r.gasUsed.toString(), from: r.from, to: r.to },
      events: norm(r.events) as Step["events"],
      error: r.error ? (norm({ name: r.error.name, args: r.error.args }) as Step["error"]) : undefined,
      at: new Date().toISOString(),
    };
    this.steps.push(step);
    const tag = r.status === "success" ? "✓" : "✗ (expected revert)";
    console.log(`  ${tag} ${id.padEnd(5)} ${s.title}${r.error ? `  → ${r.error.name}` : ""}  ${r.hash}`);
    this.flush();
    return r;
  }

  offchain(id: string, s: Omit<Step, "id" | "at" | "offchain" | "expect">) {
    this.steps.push({ ...s, id, offchain: true, expect: "success", at: new Date().toISOString() });
    console.log(`  • ${id.padEnd(5)} ${s.title}`);
    this.flush();
  }

  flush() {
    writeFileSync(`${this.dir}/manifest.json`, JSON.stringify(norm({ ...this.meta, steps: this.steps }), null, 2));
  }
}
