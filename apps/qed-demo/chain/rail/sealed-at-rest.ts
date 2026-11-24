/**
 * The wallet service's secrets at rest, sealed under the key-encryption key (docs/ENCRYPTION.md section 9; the owner's
 * authorisation in R12 section 5, which settles question 7 of section 7 for the research environment).
 *
 * Two files hold secrets: master.key, the host's master secret (every host and workspace key is derived from it), and
 * cosigner.key, the co-signer's own keys per workspace and version. Only the wallet service opens either (R13, least
 * privilege): it reads cosigner.key here and hands its bytes to the co-signer's process over an inherited pipe at each
 * start, and writes the keys the co-signer makes when it sends them back (cosigner-client.ts). The co-signer's process
 * is given no key setting and imports nothing from this module. With sealing on (QED_RAIL_SEAL=1, which
 * scripts/review-build.sh sets once a key-encryption key exists) each is kept only as <file>.sealed: one AES-256-GCM
 * message under the active data key of the wallet-secret keyring, bound to the file's name. That keyring is of its own
 * purpose (key separation from backups and migration copies) and lives with the key-encryption key in the key folder
 * (~/.qed/keys). A copy of it, wrapped by the same key-encryption key as every keyring copy is, is kept beside the
 * sealed files (keyring.json in the rail folder, refreshed once per process and after every seal; a rewrap of the
 * key-encryption key refreshes it too) and so goes into every archive of the wallet service:
 * the escrowed key-encryption key and any one of those copies open the sealed secrets (independent review of 09db70b,
 * H-1).
 *
 * Writing: sealed into <file>.sealed.partial (mode 600, exclusive), read back and decrypted, compared with what was
 * meant, synced, then put in place: by a hard link that fails if a sealed file already exists, when the secret is new
 * (so two first starts cannot both make one), else by rename. A plaintext file found while sealing is on is checked
 * for form, sealed that way, and only then removed. After a rotation of the keyring the next read re-seals under the
 * active version. Synced means fsync(2): on macOS that does not force the drive's own cache (F_FULLFSYNC).
 *
 * Reading: a sealed file is always read sealed, whether sealing is on or not, and without the key-encryption key or the
 * keyring it refuses rather than falling back to anything. A plaintext file beside it must hold the same bytes, or
 * nothing is read; it is removed only while sealing is on (with sealing off it may be a rollback in progress).
 *
 * The rail folder is locked (sealing.lock, the holder's pid) by a wallet service that seals or reads sealed secrets, and
 * by the operator's seal and unseal (scripts/wallet-sealing.ts), so neither changes a file the other is using.
 *
 * Without sealing (tests, fixture stacks, a fresh clone without keys) the plaintext files are used as before, unless
 * QED_RAIL_SEAL=1 is in the environment. What this is not: the wallet service holds the key-encryption key while it
 * runs, as the API does, so a process of the same user can still read the secrets. This keeps them out of the data
 * folder, its copies and any copy of the repository folder.
 */
import { closeSync, existsSync, fsyncSync, linkSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { basename, dirname, join } from "node:path";
import { keyPaths, openKeyring } from "../../server/key-config.ts";
import { KeyError, parseHeader, type Keyring } from "../../server/keys.ts";

export const SEALED_SUFFIX = ".sealed";
export const KEYRING_COPY = "keyring.json"; // the name every keyring copy has, so key-management tooling finds and refreshes it
export const LOCK_FILE = "sealing.lock";
export const sealingOn = (env: Record<string, string | undefined> = process.env): boolean => env.QED_RAIL_SEAL === "1";
const contextOf = (path: string): string => `qed-wallet-secret:${basename(path)}`;

let cached: Keyring | null = null;
/** The wallet-secret keyring, opened once per process; a key file inside the wallet's data folder is refused. */
export function walletRing(dataDir: string): Keyring {
  if (cached) return cached;
  try {
    cached = openKeyring("wallet-secret", { forbidden: [dataDir] });
  } catch (e) {
    if (e instanceof KeyError && e.code === "keyring_missing" && existsSync(join(dataDir, KEYRING_COPY))) {
      throw new KeyError("keyring_missing", `The wallet-secret keyring is not in the key folder (${keyPaths().dir}). A copy, wrapped by the same key-encryption key, is beside the sealed secrets at ${join(dataDir, KEYRING_COPY)} and in every wallet-service archive: put it back with \`node scripts/wallet-sealing.ts restore-keyring\` while the wallet service is stopped.`);
    }
    throw e;
  }
  return cached;
}
export interface SecretOptions {
  seal?: boolean;
  ring?: () => Keyring;
  /** Checks the secret's form; throws to refuse it. Runs before a plaintext file is sealed and after a sealed one is opened. */
  validate?: (b: Buffer) => void;
}
const ringOf = (path: string, o: SecretOptions): Keyring => (o.ring ? o.ring() : walletRing(dirname(path)));

function open(ring: Keyring, sealedPath: string, path: string): Buffer {
  return ring.decrypt(readFileSync(sealedPath), contextOf(path));
}
function syncDir(dir: string): void {
  const fd = openSync(dir, "r");
  try { fsyncSync(fd); } finally { closeSync(fd); }
}

let refreshedIn: string | null = null;
/**
 * The keyring's copy beside the sealed files (wrapped keys only, mode 600), made or refreshed after every seal. It never
 * replaces a copy that holds a data key this keyring lacks (a keyring made anew after the key folder was lost would
 * otherwise destroy the one copy that opens the secrets: re-check of d67c514, N-1), and never one written after a
 * rewrap by a process still holding the keyring from before it (N-4): such a copy is newer, and is left.
 */
export function keepKeyringCopy(ring: Keyring, dir: string): void {
  const copy = join(dir, KEYRING_COPY);
  if (existsSync(copy)) {
    let f: { keys?: { kid?: string }[]; generation?: number; kekId?: string } = {};
    try { f = JSON.parse(readFileSync(copy, "utf8")); } catch { /* unreadable: copyTo decides */ }
    const mine = new Set(ring.list().map((k) => k.kid));
    const missing = (f.keys ?? []).map((k) => k.kid ?? "").filter((kid) => !mine.has(kid));
    if (missing.length) throw new KeyError("keyring_copy_differs", `The keyring copy beside the sealed secrets (${copy}) holds data key ${missing.join(", ")}, which the key folder's wallet-secret keyring lacks: the key folder's keyring is not the one that sealed them. Nothing was replaced. Put the copy back with \`node scripts/wallet-sealing.ts restore-keyring\` (after moving the key folder's keyring aside).`);
    if ((f.generation ?? 0) > ring.generation) { refreshedIn = dir; return; }
  }
  ring.copyTo(copy);
  refreshedIn = dir;
}

/**
 * Seal data as path's secret: partial file, read back and compared, synced, then put in place. `fresh`: the secret is
 * new, so the sealed file must not exist yet (a hard link refuses to replace one); otherwise it is renamed over.
 */
function writeSealed(ring: Keyring, path: string, data: Buffer, fresh: boolean): void {
  const dir = dirname(path);
  const sealedPath = path + SEALED_SUFFIX;
  const partial = `${sealedPath}.partial`;
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  rmSync(partial, { force: true }); // a partial left by an interrupted write: ciphertext, never the only copy
  const blob = ring.encrypt(data, contextOf(path), { file: basename(path) });
  const fd = openSync(partial, "wx", 0o600);
  try { writeSync(fd, blob); fsyncSync(fd); } finally { closeSync(fd); }
  if (!ring.decrypt(readFileSync(partial), contextOf(path)).equals(data)) {
    rmSync(partial, { force: true });
    throw new Error(`Sealing ${basename(path)} did not read back equal; nothing was replaced.`);
  }
  if (fresh) {
    try { linkSync(partial, sealedPath); } catch (e) {
      rmSync(partial, { force: true });
      if ((e as NodeJS.ErrnoException).code === "EEXIST") throw new Error(`${basename(sealedPath)} appeared while this one was being made (another process on the same folder?); nothing was replaced.`);
      throw e;
    }
    rmSync(partial);
  } else {
    renameSync(partial, sealedPath);
  }
  syncDir(dir);
  keepKeyringCopy(ring, dir);
}

/** Where a secret stands: sealed (and under which key version), plaintext, or absent. Never reads the secret's bytes. */
export function secretState(path: string): { state: "sealed" | "plaintext" | "both" | "none"; keyVersion: number | null } {
  const sealed = existsSync(path + SEALED_SUFFIX), plain = existsSync(path);
  const keyVersion = sealed ? parseHeader(readFileSync(path + SEALED_SUFFIX)).version : null;
  return { state: sealed && plain ? "both" : sealed ? "sealed" : plain ? "plaintext" : "none", keyVersion };
}

/** Both copies' bytes as they are, changing nothing (status and checks). */
export function peekSecret(path: string, o: SecretOptions = {}): { sealed: Buffer | null; plain: Buffer | null } {
  const sealedPath = path + SEALED_SUFFIX;
  return { sealed: existsSync(sealedPath) ? open(ringOf(path, o), sealedPath, path) : null, plain: existsSync(path) ? readFileSync(path) : null };
}

/**
 * The secret at path, or null when there is none. A sealed file wins and must open; with sealing on, a plaintext file
 * is checked, sealed, verified and removed first, and a sealed file under a retired key version is re-sealed under the
 * active one.
 */
export function readSecret(path: string, o: SecretOptions = {}): Buffer | null {
  const seal = o.seal ?? sealingOn();
  const sealedPath = path + SEALED_SUFFIX;
  if (existsSync(sealedPath)) {
    const ring = ringOf(path, o);
    const plain = open(ring, sealedPath, path);
    o.validate?.(plain);
    const equalPlain = existsSync(path)
    if (equalPlain && !readFileSync(path).equals(plain)) throw new Error(`${basename(path)} and ${basename(sealedPath)} hold different secrets; neither was used or removed. Keep both and establish which is right (docs/ENCRYPTION.md section 9).`);
    // the keyring's copy first: if it refuses (another keyring's copy is there), nothing is removed (final pass, F-1)
    if (seal && parseHeader(readFileSync(sealedPath)).version !== ring.activeVersion) writeSealed(ring, path, plain, false);
    else if (seal && refreshedIn !== dirname(path)) keepKeyringCopy(ring, dirname(path)); // once per process: current after a rotation or rewrap
    if (seal && equalPlain) { rmSync(path); syncDir(dirname(path)); } // equal and sealed: with sealing on the plaintext is redundant
    return plain;
  }
  if (!existsSync(path)) return null;
  const plain = readFileSync(path);
  o.validate?.(plain); // a malformed secret is refused before anything is sealed or removed
  if (!seal) return plain;
  writeSealed(ringOf(path, o), path, plain, true);
  rmSync(path);
  syncDir(dirname(path));
  return plain;
}

/**
 * Write the secret at path: sealed when sealing is on or a sealed file already exists, else plaintext (mode 600).
 * `fresh`: a new secret, which must not replace anything.
 */
export function writeSecret(path: string, data: Buffer, o: SecretOptions & { fresh?: boolean } = {}): void {
  const seal = o.seal ?? sealingOn();
  const sealedExists = existsSync(path + SEALED_SUFFIX);
  if (o.fresh && (sealedExists || existsSync(path))) throw new Error(`${basename(path)} already exists; a new secret does not replace it.`);
  if (seal || sealedExists) {
    writeSealed(ringOf(path, o), path, data, o.fresh === true);
    if (existsSync(path)) { rmSync(path); syncDir(dirname(path)); }
    return;
  }
  const tmp = `${path}.partial`;
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  rmSync(tmp, { force: true });
  const fd = openSync(tmp, "wx", 0o600);
  try { writeSync(fd, data); fsyncSync(fd); } finally { closeSync(fd); }
  if (o.fresh) {
    try { linkSync(tmp, path); } finally { rmSync(tmp, { force: true }); }
  } else {
    renameSync(tmp, path);
  }
  syncDir(dirname(path));
}

/**
 * The rollback: the plaintext file back from the sealed one, byte for byte, written exclusively (mode 600), synced and
 * read back equal (checked again just before) the sealed file is removed. Only under the folder's lock
 * (scripts/wallet-sealing.ts), so no wallet service is using the files.
 */
export function unsealSecret(path: string, o: SecretOptions = {}): "unsealed" | "none" {
  const sealedPath = path + SEALED_SUFFIX;
  if (!existsSync(sealedPath)) return "none";
  const plain = open(ringOf(path, o), sealedPath, path);
  if (existsSync(path)) throw new Error(`${basename(path)} already exists beside its sealed file; nothing was changed.`);
  const fd = openSync(path, "wx", 0o600);
  try { writeSync(fd, plain); fsyncSync(fd); } finally { closeSync(fd); }
  syncDir(dirname(path));
  if (!existsSync(path) || !readFileSync(path).equals(plain)) throw new Error(`${basename(path)} did not read back equal; the sealed file was kept.`);
  rmSync(sealedPath);
  syncDir(dirname(path));
  return "unsealed";
}

const alive = (pid: number): boolean => { try { process.kill(pid, 0); return true; } catch (e) { return (e as NodeJS.ErrnoException).code === "EPERM"; } };
const code = (e: unknown): string | undefined => (e as NodeJS.ErrnoException).code;

/**
 * Take the rail folder's lock for this process (re-entrant), or refuse while a live process holds it. The lock file is
 * written whole, then hard-linked into place, so it is never seen empty or half written; a lock whose process is gone is
 * moved aside first and removed only if it is still that dead process's, so two processes taking over the same dead
 * lock cannot both hold it (re-check of d67c514, N-2). Released when the returned function is called or the process
 * exits. Residual: a third process creating a lock in the instant between a takeover's move and its put-back.
 */
export function lockFolder(dir: string): () => void {
  const p = join(dir, LOCK_FILE);
  const mine = `${process.pid}\n`;
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  for (let attempt = 0; attempt < 20; attempt++) {
    const tmp = join(dir, `${LOCK_FILE}.${process.pid}.${randomBytes(4).toString("hex")}`);
    const fd = openSync(tmp, "wx", 0o600);
    try { writeSync(fd, mine); fsyncSync(fd); } finally { closeSync(fd); }
    try {
      linkSync(tmp, p);
      rmSync(tmp);
      let done = false;
      const release = (): void => {
        if (done) return;
        done = true;
        try { if (readFileSync(p, "utf8") === mine) rmSync(p); } catch { /* already gone */ }
      };
      process.once("exit", release);
      return release;
    } catch (e) {
      rmSync(tmp, { force: true });
      if (code(e) !== "EEXIST") throw e;
    }
    let holder: number;
    try { holder = Number(readFileSync(p, "utf8").trim()); } catch (e) { if (code(e) === "ENOENT") continue; throw e; } // released meanwhile
    if (holder === process.pid) return () => {};
    if (!Number.isInteger(holder) || holder <= 0) throw new Error(`The lock file ${p} does not name a process (damaged or altered). If no wallet service is running on this folder, delete it by hand and start again.`);
    if (alive(holder)) throw new Error(`The wallet service's folder ${dir} is in use by process ${holder}; stop it first (scripts/review-build.sh stop).`);
    const aside = join(dir, `${LOCK_FILE}.stale.${randomBytes(4).toString("hex")}`);
    try { renameSync(p, aside); } catch (e) { if (code(e) === "ENOENT") continue; throw e; }
    if (Number(readFileSync(aside, "utf8").trim()) !== holder) {
      try { linkSync(aside, p); } catch { /* a newer lock is in place */ } // another process took it over meanwhile: its lock goes back
    }
    rmSync(aside, { force: true });
  }
  throw new Error(`Could not take the lock on ${dir}.`);
}

/** Whether a secret here is sealed (so a reader needs the keys and the folder's lock). */
export const anySealed = (dir: string, files: readonly string[]): boolean => files.some((f) => existsSync(join(dir, f + SEALED_SUFFIX)));
