/**
 * What the co-signer's process is given (R13 least privilege, docs/LEAST-PRIVILEGE.md): its environment, the file
 * descriptor its keys arrive on, and the form those keys must have. Kept apart from cosigner-client.ts, with no imports,
 * so that the server's least-privilege test checks exactly what the rail uses.
 */

/** The file descriptor on which the co-signer receives its key file's bytes at start (cosigner-main.ts reads it). */
export const KEYS_FD = 4;

/**
 * The co-signer's whole environment: exactly these six names, whatever this process's own environment holds. No key
 * setting (QED_KEY_DIR, QED_KEY_FILE, QED_KEK, QED_RAIL_SEAL) and not the key file's path: it receives its keys on
 * KEYS_FD. HOME is an empty folder of its own (R13 review fix F3 (ii)), not the user's: the key folder's default
 * location is under the user's HOME. TSX_DISABLE_CACHE keeps its compiled code in memory: a cache in /tmp could be planted by
 * another user before it starts (independent review of the fixes, M2). Its code opens no keyring at all (server/least-privilege.test.ts checks its imports).
 */
export function cosignerEnv(o: { stateFile: string; vendorRoot: string; home: string }, env: Record<string, string | undefined> = process.env): Record<string, string> {
  return { PATH: env.PATH ?? "", HOME: o.home, QED_COSIGNER_STATE: o.stateFile, QED_COSIGNER_VENDOR_ROOT: o.vendorRoot, NODE_NO_WARNINGS: "1", TSX_DISABLE_CACHE: "1" };
}

/**
 * How the co-signer is started (R13 review fix F3 (iii)). With QED_COSIGNER_UID and QED_COSIGNER_GID set (the container
 * sets them to its own unprivileged user, scripts/deploy/entrypoint.sh), through setpriv as that user: no supplementary
 * groups, no inheritable or ambient capabilities, no way to gain privileges. Then the operating system keeps it out of
 * the wallet service's key folder, data folder and /proc/<pid>/environ. Otherwise as this process's own user.
 */
export function cosignerCommand(entry: string[], env: Record<string, string | undefined> = process.env): { file: string; args: string[] } {
  const uid = env.QED_COSIGNER_UID, gid = env.QED_COSIGNER_GID;
  if (!uid && !gid) return { file: process.execPath, args: entry };
  if (!/^[1-9]\d*$/.test(uid ?? "") || !/^[1-9]\d*$/.test(gid ?? "")) throw new Error("QED_COSIGNER_UID and QED_COSIGNER_GID must both be the numeric ids of an unprivileged user (not 0)");
  return { file: env.QED_SETPRIV || "/usr/bin/setpriv", args: [`--reuid=${uid}`, `--regid=${gid}`, "--clear-groups", "--inh-caps=-all", "--ambient-caps=-all", "--no-new-privs", "--", process.execPath, ...entry] };
}

/**
 * Where the co-signer writes the decision records of one workspace scope (R14). With a folder of its own (`own`: the
 * container's QED_COSIGNER_STATE_DIR, which scripts/deploy/entrypoint.sh gives to the co-signer's user), they go there,
 * beside its replay state: `<own>/records/<scope>`. That user cannot enter the wallet service's data folder (R13 review
 * fix F3), so a records folder inside it stopped every new workspace: the co-signer could not be configured for it
 * (EACCES), and no on-chain wallet could be set up on the deployed image (25 Nov 2026). Without a folder of its own (one
 * user, a development machine) the records stay where they were, in the workspace's own folder (`fallback`).
 * The wallet service does not read these files: every verdict comes back with its record's text, which it keeps in the
 * workspace's own store.
 */
export function cosignerRecordsDir(own: string | null | undefined, scope: string, fallback: string): string {
  if (!own) return fallback;
  // one path component, as rail/cosigner.ts SCOPE_RE has it (not imported: this file imports nothing)
  if (!/^[a-z0-9][a-z0-9-]{2,62}$/.test(scope)) throw new Error("invalid co-signer scope");
  return `${own.replace(/\/+$/, "")}/records/${scope}`;
}

/** The key file's form: { "<scope>": { "<version>": "0x" + 64 hex } }, or the legacy { "<version>": "0x…" }. */
export function checkKeyFile(b: Buffer): void {
  let raw: unknown;
  try { raw = JSON.parse(b.toString("utf8")); } catch { throw new Error("the co-signer's key file is not valid JSON; it was left unchanged"); }
  const key = (v: unknown) => typeof v === "string" && /^0x[0-9a-f]{64}$/i.test(v);
  const versions = (o: unknown) => !!o && typeof o === "object" && !Array.isArray(o) && Object.entries(o).every(([k, v]) => /^\d{1,6}$/.test(k) && key(v));
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("the co-signer's key file does not hold keys by scope and version; it was left unchanged");
  const legacy = Object.keys(raw).length > 0 && Object.keys(raw).every((k) => /^\d+$/.test(k));
  if (!(legacy ? versions(raw) : Object.values(raw).every(versions))) throw new Error("the co-signer's key file does not hold keys by scope and version; it was left unchanged");
}
