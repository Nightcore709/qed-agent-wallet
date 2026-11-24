/**
 * The co-signer's deny list (baseline F-033, check C11 "Sanctions / deny-list screening"), with where it came from and as
 * of when, and a recorded way to change it (R13, mandate-omissions audit P7: the list was one address fixed in code).
 *
 * The list in force is `<railDir>/denylist.json`. With no such file, the list is the built-in one: the wallet service's
 * own derived "denied" test address (host:denylisted), which stands for a payee no mandate may pay. It is labelled as
 * that: it is not a sanctions list, and no sanctions list is loaded. Loading one (for example OFAC's SDN list, which
 * names some digital-currency addresses) is the owner's decision; an entry from it would only mean something on a chain
 * where that address can exist, and this one is a disposable local chain.
 *
 * Changing it: `node --import tsx rail/denylist.ts set <file.json> --by "<who>"` (from apps/qed-demo/chain, with the
 * wallet service stopped; QED_RAIL_DATA chooses its folder). The file states `source` and `asOf` (YYYY-MM-DD) and each
 * entry's address and reason. Every change first appends a record to `<railDir>/denylist-history.jsonl`: when, by whom,
 * the source, the date, the entries and the SHA-256 of the record before it, so the history is a chain a reader can
 * check (`verify`). The list in force is then replaced. The co-signers read it when the service starts.
 */
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { getAddress, isAddress, type Address } from "viem";
import { atomicWrite } from "./anvil.ts";

export interface DenyEntry { address: Address; reason: string }
export interface DenyList { version: 1; source: string; asOf: string; entries: DenyEntry[]; builtIn?: true }
export interface DenyRecord { at: string; by: string; source: string; asOf: string; entries: DenyEntry[]; previous: string | null; hash: string }

export const BUILT_IN_SOURCE = "QED's own test entry: the wallet service's derived 'denied' address (host:denylisted), standing for a payee no mandate may pay. Not a sanctions list.";
export const BUILT_IN_AS_OF = "2026-11-24";
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const sha256 = (s: string): string => createHash("sha256").update(s, "utf8").digest("hex");

/** Refuses a list without a source, a date, or with an entry that is not an address with a reason. */
export function checkDenyList(raw: unknown): DenyList {
  const o = raw as Partial<DenyList> | null;
  if (!o || typeof o !== "object") throw new Error("A deny list is a JSON object: { source, asOf, entries }.");
  const source = typeof o.source === "string" ? o.source.trim() : "";
  const asOf = typeof o.asOf === "string" ? o.asOf.trim() : "";
  if (source.length < 3) throw new Error("A deny list says where it comes from: `source` (for a published list, its publisher and address).");
  if (!DATE.test(asOf) || Number.isNaN(Date.parse(`${asOf}T00:00:00Z`))) throw new Error("A deny list says as of when: `asOf`, a date YYYY-MM-DD.");
  if (!Array.isArray(o.entries)) throw new Error("A deny list has `entries`: [{ address, reason }].");
  const seen = new Set<string>();
  const entries = o.entries.map((e, i) => {
    const address = typeof e?.address === "string" ? e.address.trim() : "";
    const reason = typeof e?.reason === "string" ? e.reason.trim() : "";
    if (!isAddress(address)) throw new Error(`Entry ${i + 1}: ${JSON.stringify(address)} is not an address.`);
    if (!reason) throw new Error(`Entry ${i + 1}: give the reason it is listed.`);
    const a = getAddress(address);
    if (seen.has(a)) throw new Error(`Entry ${i + 1}: ${a} is listed twice.`);
    seen.add(a);
    return { address: a, reason };
  });
  return { version: 1, source, asOf, entries };
}

/** The list in force: the folder's own, or the built-in one naming `builtIn` (the service's derived test address). */
export function loadDenyList(railDir: string, builtIn: Address[]): DenyList {
  const file = join(railDir, "denylist.json");
  if (!existsSync(file)) return { version: 1, source: BUILT_IN_SOURCE, asOf: BUILT_IN_AS_OF, entries: builtIn.map((address) => ({ address: getAddress(address), reason: "built-in test entry" })), builtIn: true };
  return checkDenyList(JSON.parse(readFileSync(file, "utf8")));
}

/** Every recorded change, oldest first, each checked against the one before it. Throws at the first that does not hold. */
export function denyHistory(railDir: string): DenyRecord[] {
  const file = join(railDir, "denylist-history.jsonl");
  if (!existsSync(file)) return [];
  const out: DenyRecord[] = [];
  for (const [i, line] of readFileSync(file, "utf8").split("\n").filter(Boolean).entries()) {
    const r = JSON.parse(line) as DenyRecord;
    const { hash, ...body } = r;
    if (r.previous !== (out.at(-1)?.hash ?? null) || hash !== sha256(JSON.stringify(body))) throw new Error(`The deny list's history does not hold at record ${i + 1}: it was changed or a record is missing.`);
    out.push(r);
  }
  return out;
}

/** Records the change, then puts the new list in force. Returns the record. */
export function setDenyList(railDir: string, raw: unknown, by: string, now = new Date()): DenyRecord {
  const list = checkDenyList(raw);
  const who = by.trim();
  if (!who) throw new Error("Say who made the change: --by \"<name>\".");
  const previous = denyHistory(railDir).at(-1)?.hash ?? null;
  const body = { at: now.toISOString(), by: who, source: list.source, asOf: list.asOf, entries: list.entries, previous };
  const record: DenyRecord = { ...body, hash: sha256(JSON.stringify(body)) };
  appendFileSync(join(railDir, "denylist-history.jsonl"), `${JSON.stringify(record)}\n`, { mode: 0o600 });
  atomicWrite(join(railDir, "denylist.json"), `${JSON.stringify(list, null, 1)}\n`);
  return record;
}

// node --import tsx rail/denylist.ts show | verify | set <file.json> --by "<who>"
if (import.meta.url === `file://${process.argv[1]}`) {
  const { defaultConfig } = await import("./config.ts");
  const railDir = defaultConfig().railDir;
  const [cmd, file] = process.argv.slice(2);
  const byAt = process.argv.indexOf("--by");
  try {
    if (cmd === "show") console.log(JSON.stringify(existsSync(join(railDir, "denylist.json")) ? loadDenyList(railDir, []) : { built_in: BUILT_IN_SOURCE, asOf: BUILT_IN_AS_OF }, null, 1));
    else if (cmd === "verify") console.log(`${denyHistory(railDir).length} recorded change(s); the history holds.`);
    else if (cmd === "set" && file) {
      if (existsSync(join(railDir, "anvil.pid"))) throw new Error("The wallet service seems to be running (its chain's pid file is there): stop it first; the co-signers read the list when it starts.");
      const r = setDenyList(railDir, JSON.parse(readFileSync(file, "utf8")), byAt > 0 ? process.argv[byAt + 1] ?? "" : "");
      console.log(`Recorded (${r.hash.slice(0, 16)}…) and in force at the next start: ${r.entries.length} entr${r.entries.length === 1 ? "y" : "ies"}, source "${r.source}", as of ${r.asOf}.`);
    } else { console.error('Usage: rail/denylist.ts show | verify | set <file.json> --by "<who>"'); process.exit(2); }
  } catch (e) { console.error(e instanceof Error ? e.message : String(e)); process.exit(1); }
}
