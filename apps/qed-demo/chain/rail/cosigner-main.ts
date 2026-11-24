/**
 * The co-signer as its own process (baseline correction e; W-08, X-04), shared by every workspace of the host.
 *
 * Started by the rail (cosigner-client.ts) with an environment of exactly PATH, HOME, NODE_NO_WARNINGS and two paths
 * (its state file and the vendored release's root): no key setting and not even its key file's path. Its signing keys
 * (32 random bytes each, one per workspace scope and key version) arrive at start as the bytes of its key file on file
 * descriptor 4, which the rail opened for it (sealed under the key-encryption key when sealing is on, else plaintext of
 * mode 600); this process opens no keyring and imports no key-handling module (R13, docs/LEAST-PRIVILEGE.md). A key it
 * creates (a new scope, or the next version at a rotation) is sent back to the rail over the IPC channel to be written,
 * and the request that needed it is answered only once the rail has written it: no address or signature of a key that
 * could be lost ever leaves. The rail learns those bytes only to store them; it never signs with them.
 * It runs the release's unmodified PolicyEngine (through CosignerCore), one configured engine per scope, and answers
 * over the IPC channel, one request at a time. When the rail goes away, it exits.
 *
 * Key file: { "<scope>": { "<version>": "0x…" } }. A file written before scopes existed holds { "<version>": "0x…" }
 * at its top level: those are the baseline workspace's keys and are read as such.
 *
 * What this is and is not: a separate process that holds only its own keys. It is not OS-level isolation: both
 * processes run as the same user on one machine, so a compromised process of that user could read the key folder. A
 * separate user, machine, HSM or KMS is a production matter (baseline L-01).
 */
import { closeSync, readFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { privateKeyToAccount } from "viem/accounts";
import type { Hex } from "viem";
import { CosignerScopes, SCOPE_RE } from "./cosigner.ts";
import { loadVendored } from "./vendored.ts";

/** Where the rail writes this process's key file's bytes at start (cosigner-client.ts KEYS_FD). */
const KEYS_FD = 4;
const stateFile = process.env.QED_COSIGNER_STATE!, vendorRoot = process.env.QED_COSIGNER_VENDOR_ROOT!;
if (!stateFile || !vendorRoot || typeof process.send !== "function") {
  console.error("cosigner: must be started by the rail with its state file, vendored root and key pipe");
  process.exit(2);
}

type KeyFile = Record<string, Record<string, Hex>>;
/** The keys as the rail handed them over: read to the end of the pipe, which is then closed. */
function receiveKeys(): KeyFile {
  let bytes: Buffer;
  try { bytes = readFileSync(KEYS_FD); } catch { console.error("cosigner: no key pipe on file descriptor 4"); process.exit(2); }
  try { closeSync(KEYS_FD); } catch { /* already closed */ }
  if (!bytes.length) return {};
  const raw = JSON.parse(bytes.toString("utf8")) as Record<string, unknown>;
  bytes.fill(0);
  // legacy: { "1": "0x…", "2": "0x…" } belongs to the baseline workspace
  if (Object.keys(raw).length && Object.keys(raw).every((k) => /^\d+$/.test(k))) return { baseline: raw as Record<string, Hex> };
  return raw as KeyFile;
}
const all = receiveKeys();
/** Keys made in this process that the rail has not confirmed written yet: "<scope>/<version>". */
const unwritten = new Set<string>();

/** Versioned keys per scope. A version is created the first time it is asked for, and written before it is used outside. */
const keys = (scope: string, version: number) => {
  if (!SCOPE_RE.test(scope)) throw new Error("invalid scope");
  const mine = (all[scope] ??= {});
  if (!mine[version]) {
    mine[version] = `0x${randomBytes(32).toString("hex")}`;
    unwritten.add(`${scope}/${version}`);
  }
  return privateKeyToAccount(mine[version]);
};

let ref = 0;
const waiting = new Map<number, { resolve: () => void; reject: (e: Error) => void }>();
/** Sends every key to the rail to be written, and waits for its answer. On failure the new keys are forgotten. */
async function writeNewKeys(): Promise<void> {
  if (!unwritten.size) return;
  const made = [...unwritten];
  const id = ++ref;
  try {
    await new Promise<void>((resolve, reject) => {
      waiting.set(id, { resolve, reject });
      process.send!({ persist: JSON.stringify(all), ref: id }, (e: Error | null) => { if (e) { waiting.delete(id); reject(new Error("the rail is not reachable to store a new key")); } });
    });
    for (const k of made) unwritten.delete(k);
  } catch (e) {
    for (const k of made) { const [s, v] = k.split("/"); delete all[s!]![v!]; unwritten.delete(k); }
    throw new Error(`a new co-signer key could not be stored, so it was not used: ${(e as Error).message}`);
  }
}

const v = await loadVendored(vendorRoot);
const scopes = new CosignerScopes(v, keys, stateFile);
const { toJson, fromJson } = v.eip712;
let queue: Promise<void> = Promise.resolve();
process.on("message", (m: { id: number; op: string; scope?: string; payload: string; persisted?: number; ok?: boolean; error?: string }) => {
  // the rail's answer to a key written: settles the request waiting for it (outside the queue, which is waiting on it)
  if (typeof m.persisted === "number") {
    const w = waiting.get(m.persisted);
    if (w) { waiting.delete(m.persisted); if (m.ok) w.resolve(); else w.reject(new Error(m.error ?? "not written")); }
    return;
  }
  queue = queue.then(async () => {
    try {
      if (m.op === "hello") { process.send!({ id: m.id, ok: true, payload: toJson({ pid: process.pid }) }); return; }
      if (typeof m.scope !== "string") throw new Error("every operation names its workspace scope");
      const out = await scopes.run(m.scope, m.op, fromJson(m.payload));
      await writeNewKeys(); // nothing made with a new key leaves before the key is stored
      process.send!({ id: m.id, ok: true, payload: toJson(out) });
    } catch (e) {
      process.send!({ id: m.id, ok: false, error: String((e as Error).message ?? e).split("\n")[0].slice(0, 300) });
    }
  });
});
process.on("disconnect", () => process.exit(0));
process.send({ id: 0, ok: true, payload: toJson({ ready: true }) });
