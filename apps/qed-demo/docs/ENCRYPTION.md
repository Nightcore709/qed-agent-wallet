# Encryption at rest, key management, backups and recovery

Register rows R7-076 (encryption at rest and key management) and R7-085 (availability, recovery time, acceptable data
loss, backup restoration); architecture decision D10 (`docs/r7/00-ARCHITECTURE-DECISIONS.md`). Written 22 Nov 2026 by
the qed-engineer specialist. Every claim is labelled **Verified** (reproduced here, with the command or file named) or
**Hypothesis** (plausible, not tested).

**Status on 24 Nov 2026 (R11 section 11; Verified unless marked).** Supersedes the 22 Nov status below where they differ.

- **Migration copies are sealed, never plaintext.** Before a schema migration, `openDb` (`server/core.ts`) calls
  `sealMigrationCopy` (`server/migration-copy.ts`): a consistent copy is sealed under the *migration-copy key*, read back
  and checked, and only then does the migration run. If the copy cannot be sealed (no key, a wrong or altered key, a key
  file others can read, a temporary folder that cannot be used, a plaintext snapshot that cannot be removed, a check
  that fails), the migration does not run and the database is left as it was; the process stops with the reason and the
  fix. There is no plaintext copy and no fallback to one. The `qed.db.pre-vN-….bak` files of 20 to 23 Nov were the last.
- **Key separation.** One keyring per purpose: `database` (D10's field encryption: reserved, nothing is sealed under it
  yet), `backup` and `migration-copy`. The purpose is authenticated, data key ids name it (`dek_backup_…`,
  `dek_migration-copy_…`), and one purpose's keyring never opens or stands in for another's (section 3).
- **Commands with defaults** (section 4): `npm run keys:init`, `keys:status`, `backup`, `backup:verify`, `backup:drill`
  (restores into a private scratch folder and runs `node server/main.ts verify` on it), `restore`; rotation,
  re-encryption of every older copy (`reencrypt --all`), revocation (refused while a copy still needs the version).
- **`npm run reset`** seals the database into the backup folder and removes it, or, without the backup key, refuses and
  changes nothing. It no longer moves the database aside in plaintext.
- **The plaintext copies of 20 to 23 Nov:** `npm run plaintext:scan` finds them; `npm run plaintext:archive` seals them
  into an archive under the backup key, checks every entry byte for byte against its original, and leaves the originals
  where they are. Removal is a separate command that needs `--remove-plaintext` and the archive's id typed back. **None of
  this was run on the review machine's data folder**: deleting them is the owner's decision (section 7). It was rehearsed
  on copies (section 6).
- **Not built:** encryption of the live database (section 5: volume encryption now, field encryption before
  production); backups of the vault service's data (section 7, question 7); a backup schedule, monitoring, off-host
  copies and detection of an older *backup set* put in place of a newer one (a rolled-back *keyring* is now refused).
- Tests: `server/keys.test.ts` (19), `server/key-separation.test.ts` (10), `server/backup.test.ts` (14),
  `server/migration-copy.test.ts` (10), `server/backup-cli.test.ts` (9), `server/plaintext-archive.test.ts` (10),
  `server/canonical-ids.test.ts` (4 of its 7 cover the migration and its copy). *(Counts as of `cb85271`; see below.)*

**Corrections after an independent review of `cb85271` (24 Nov 2026, later; Verified, each by a test that failed on
`cb85271` first).** The review was read-only and confirmed six faults; all six are fixed, and its three suspicions are
addressed.

1. *An interrupted seal left a full plaintext copy, never swept* (High). A signal during a start-up migration killed the
   process with its snapshot on disk. Now `server/main.ts`, `scripts/backup.ts` and `scripts/plaintext-copies.ts` take
   SIGINT, SIGTERM and SIGHUP from the start: every seal, reset, restore, extraction and drill is synchronous, so a signal
   waits for the step and its clean-up to finish. Every scratch folder that can hold plaintext records its owner
   (`server/scratch.ts`), and the next operation of the same kind in the same place sweeps the ones a SIGKILL, crash or
   power cut left: files overwritten with zeros, then removed, each reported; a folder whose owner may still be running
   (or made on another computer) is left and reported; one that cannot be removed stops the operation. Overwriting is
   best effort: APFS is copy-on-write, so the old blocks are freed, not erased; FileVault protects them. Until the next
   operation in that place, a SIGKILL's leftover stays on disk (`npm run plaintext:scan` lists it as temporary).
   Tests: `server/interrupt.test.ts`.
2. *Guards compared path text, and APFS ignores case* (High). `archive --file …/DATA/QED.db` was accepted for the live
   `…/Data/qed.db`, and `remove` then deleted the live database; a key file could be made inside a forbidden folder named
   in another case. Now files are compared by device and inode (any case, symbolic or hard link), folders by walking up
   to the folder's own inode, and paths that do not exist yet by canonical path (`realpath.native`, then case-folded on
   macOS). Removal takes the configured live database and checks each original again immediately before unlinking it:
   still the file that was compared (identity, size, time), not the live database, not open. Tests:
   `server/path-identity.test.ts`.
3. *Revoke missed copies elsewhere; keyring copies kept the revoked key; a rolled-back keyring was accepted* (Medium).
   Now each keyring records the folders where copies were made under it (`<keyring>.places`), and `reencrypt --all`,
   `revoke` and `backup:verify` cover all of them; `revoke` refuses while any copy there still needs the version, or a
   recorded folder cannot be reached, and afterwards rewrites every known copy of the keyring (archives' own copies
   included); copies made elsewhere are named as still holding the key. A keyring carries an authenticated generation,
   raised by every change; the highest one written is kept beside it (`<keyring>.generation`), and an older copy put
   back is refused (`keyring_rolled_back`). The `keyring_missing` message says to put back only the newest copy. Tests:
   `server/key-separation.test.ts`, `server/backup-cli.test.ts`.
4. *Ctrl-C during `backup:drill` left the restored database in `$TMPDIR`* (Medium). Fixed by 1 (signals wait; the drill's
   own clean-up runs) and a sweep of stale `qed-drill-*` folders at the next drill. Tests: `server/interrupt.test.ts`.
5. *"Nothing was changed" was false with a write-ahead log waiting* (Low): closing the refused connection checkpointed
   the log. Now a read-only connection is opened first, so the database file and its log stay byte for byte (the `-shm`
   index may be rewritten; it holds no data), and the message says so. Test: `server/migration-copy.test.ts`.
6. *One file named in two cases became two entries, and removal stopped with no record* (Low). Entries are now one per
   file by identity; an original that vanished counts as already gone; a removal that stops part-way records what it
   removed and where it stopped. Tests: `server/path-identity.test.ts`.

Tests after the corrections (118 in ten files, all passing; each new one failed first, and 19 deliberate mutations of the
guards, from skipping the check after writing to taking signals after the database is opened, each failed a test):
`server/keys.test.ts` (19), `server/key-separation.test.ts` (14), `server/backup.test.ts` (14),
`server/migration-copy.test.ts` (13), `server/backup-cli.test.ts` (14), `server/plaintext-archive.test.ts` (12),
`server/interrupt.test.ts` (13), `server/path-identity.test.ts` (10), `server/canonical-ids.test.ts` (7),
`server/core.test.ts` (2). The reviewer's probes were run again on the corrected code: the live database named in
another case is refused, a key path in another case is refused, the `--out` copy is re-encrypted before revoke passes,
the archive's own keyring copy no longer holds the revoked key, a waiting log is left byte for byte, and a SIGINT during
a drill leaves nothing in the temporary folder; probe 1, with its trigger adapted to the new layout (it looked for a
`.partial` beside the copies, which now lives in a sealing folder), sent SIGTERM and SIGINT 157 ms into sealing a 126 MB
database: the process waited, the copy completed and verified, and no snapshot was left.

The suspicions: `archive.json` is now sealed beside itself (`record.qedseal`) and authenticated by verify, extraction,
removal and re-encryption; a database with a `-wal`, `-shm` or `-journal` beside it counts as possibly open whatever its
name; sealed files and archives are written in owned scratch folders and moved into place, and stale ones are swept.
For the merge with the S3 schema work: a migration that fails after its copy does not pile up copies across restarts; an
unchanged database (same snapshot SHA-256: `VACUUM INTO` is byte-deterministic for the same content, checked on SQLite
3.54) reuses its newest copy after checking it again.

**22 Nov 2026 status (kept as written):** **What is built (Verified):** a key provider with versioned data keys wrapped
by a key-encryption key (`server/keys.ts`); encrypted, authenticated backups with a manifest and a verifying restore
(`server/backup.ts`); the operator tool `scripts/backup.ts`; the restore drill `scripts/restore-drill.ts`; tests
`server/keys.test.ts` (19) and `server/backup.test.ts` (14).
**What is not built:** encryption of the live database itself (section 5 is the decision and the plan; no half
measure is implemented). Nothing is wired into `server/main.ts` or `server/core.ts` yet; the patches are in the
hand-back of 22 Nov, because other specialists are editing those files. *(Superseded on 24 Nov: wired, see above.)*

## 1. Inventory: what is stored, and how sensitive it is

Facts from the code are cited by file and line; facts about the review machine come from `ls -la apps/qed-demo/data`
on 22 Nov (file names, sizes and modes only: no review file was opened).

| Store | What it holds | Sensitive | Protection on 22 Nov (Verified) |
|---|---|---|---|
| `data/qed.db` (node:sqlite, schema v3, 11.4 MB) | every table of `server/schema.sql` (below) | yes: all categories | mode 600; data folder mode **755**; FileVault on |
| `qed.db-wal` (4.2 MB), `qed.db-shm` | recently written pages (the WAL), and its index | as the database | mode 600 |
| free pages inside `qed.db` | text of deleted rows: `secure_delete` is off | as the database | none: a deleted value stays in the file until it is overwritten or vacuumed (probe below) |
| five `qed.db.*.bak` files (31.1 MB) | plaintext copies: three from `npm run reset` (`server/main.ts:58-64` renames the database aside), two from migrations (`server/core.ts:185-189`, VACUUM INTO) | as the database | mode 600; no retention, never removed |
| `data/scratch-backup-20261120/` | unknown (not opened) | assume as the database | mode 700 |
| `data/rail.db`, `-wal`, `-shm` (vault service) | proposals, approvals, jobs, mandates, policies, receipts, workspaces (`chain/rail/store.ts:19-65`) | yes: financial records and authority | mode **644**: readable by every user of the machine; `store.ts` sets no mode |
| `data/rail/cosigner.key` (`chain/rail/host.ts`, `ProcessCosigner.start`; sealed as `cosigner.key.sealed` when `QED_RAIL_SEAL=1`, section 9) | the co-signer's secp256k1 private keys, per workspace and version, as JSON (`chain/rail/cosigner-main.ts`, `readKeys`) | yes: signing keys (local chain only) | written mode 600 (as of 22 Nov, not opened then; created only when a workspace first asks the process co-signer); folder `data/rail/` mode 755 |
| `data/rail/master.key` (`chain/rail/host.ts`, `loadOrCreateMasterSecret`; sealed as `master.key.sealed` when `QED_RAIL_SEAL=1`, section 9) | the vault host's master secret, 32 random bytes as plaintext hex; every host key and every workspace's deployer, agent, guardian and relayer key is derived from it by HKDF (`chain/rail/keys.ts`, `derivedAccount`); no owner key (owners are passkeys) | yes: the most powerful service secret at rest (local chain today) | written mode 600, mode re-tightened on load (as of 22 Nov, not opened then); sealed under the KEK's wallet-secret keyring since 24 Nov when `QED_RAIL_SEAL=1` (section 9) |
| `data/rail.token` | the vault service's bearer token | credential | mode 600 |
| `data/review-account.json` | the review account's generated password | credential (paper review account) | mode 600 |
| `api.log`, `engine.log`, `rail.log`, `vite-dev.log` | for the API: on a server error, the method, the full URL with its query string, and the error with its stack (`server/api.ts:500`, the only log call there); the engine and API print the database path and process ids (`server/main.ts:28-34`); request bodies are never logged by the API | low to medium (URLs and errors) | mode **644** |
| evidence export, `GET /api/evidence/cases/:id/export` (`server/api.ts:333`) | a JSON download of one case from the workspace's records | the person's own data, plaintext by design once downloaded | session and membership checks |
| `apps/qed-demo/evidence/*.json` (in git) | outputs of test and journey runs on fixtures | must only ever hold synthetic data | committed |

**Changes since 22 Nov (24 Nov 2026).** Listed by name, size and mode on the review machine (`ls -la`), and the scratch
folder's database files found by reading only the first bytes of each file in a copy of it (no row read):

- Seven plaintext copies of the database beside it (64.5 MB, mode 600): three from `npm run reset` on 20 Nov
  (`qed.db.2026-11-20T07-*.bak`) and four from the migrations to v2, v3, v4 and v5 (`qed.db.pre-v2-…` to
  `qed.db.pre-v5-2026-11-23T14-35-22-815Z.bak`, 18.6 MB). No further plaintext copy can be made: migrations seal or
  refuse, and `npm run reset` seals or refuses (section 4).
- `scratch-backup-20261120/` (93.0 MB in 3,249 files) is no longer "unknown": besides scripts, logs and notes it holds three
  more plaintext copies of a QED database (`migration-test/qed.db`, `migration-test/qed.db.pre-v2-….bak`,
  `node22/qed.db`), one of the vault service's database (`railcopy/rail.db`), and two databases with leftover `-wal` and
  `-shm` files (`live-probe.db`, the 22 Nov probe; `r7-evidence/tmp/qed-recovery-…/qed.db` with a 4.4 MB WAL).
- New stores, all sealed: `migration-copies/` beside the database (mode 700: sealed copies, their manifests and a copy
  of the migration-copy keyring); the key folder `~/.qed/keys` (default; mode 700: `qed.kek`, mode 600, and one keyring
  per purpose); the backup folder `~/.qed/backups` (default; mode 700: sealed backups, manifests, a keyring copy, and
  `archives/` for the archives of plaintext copies). None of these exists on the review machine yet: no key has been
  made there (section 7).

The database's tables, by category (`server/schema.sql`):

- **Credentials and authenticators:** `users.pw_hash` (scrypt, `server/auth.ts:26-29`; legacy password accounts);
  `webauthn_credentials` (COSE public key and the P-256 `x`, `y` that also control the on-chain account: public keys,
  but they identify the person and link the wallet to them); `webauthn_challenges` (short-lived); `sessions.id_hash`
  (SHA-256 of the cookie token, which is never stored), `sessions.csrf` (plaintext), `sessions.ua`.
- **Recovery:** `recovery_codes` (80 random bits each, scrypt N = 2^14 since v3, `server/passkeys.ts:257-269`; older rows
  salted SHA-256), `contact_codes` (scrypt), `recovery_requests`, `recovery_contacts` (who trusts whom),
  `scheduled_changes`, `security_events`.
- **Identity and profile:** `users.handle`, `display_name`, `profile_json` (income, spending, loan instalments),
  `memberships`.
- **Conversations and model inputs:** `conversations.title`; `conversation_turns.question` and `answer` (the owner's own
  words, the most open-ended text QED stores); `ai_calls.question`, `output_json`, `sent_json` (what was sent: tokens,
  not names, `schema.sql:656`); `proposals.rationale`, `params_json`.
- **Payees and handles:** `payees.name`, `payees.handle` (UPI-style address); `bills.memo`; `earn_jobs.client`, `title`.
- **Financial records:** `entries` (memo, meta), `postings`, `balances`, `holds`, `lots`, `realised`, `pv_orders`,
  `pv_fills`, `pv_payments`, `receipts.body_json` (hash-chained), `approvals`, `approval_signatures`, `programs`,
  `runs`, `actions`, `disputes`, `recon_runs`.
- **Operations:** `audit` (`ip`, `detail_json`), `events.payload_json`, `notices`, `heartbeats`, `rate_limits`.
- **Not personal:** `assets`, `instruments`, `quotes`, `quote_history`, `daily_values`, `terms`, `provider_status`.

Probes on SQLite 3.54 in a scratch folder (Verified, 22 Nov): a row deleted and checkpointed still left its text in the
main file; a `VACUUM INTO` copy of that file did not contain it. `VACUUM INTO` from a read-only connection captured rows
still in the WAL. A read-only connection to a WAL database that nobody else had open left a 32 KiB `-shm` and an empty
`-wal` behind when it closed; `PRAGMA query_only = ON` refuses `VACUUM INTO`. `VACUUM INTO` creates its file with mode
644 (umask), but keeps the mode of an empty file made beforehand with mode 600.

**What stays visible even when encrypted:**

- *A backup file:* its size (the database's size plus 353 bytes); its header, readable without a key but authenticated:
  the backup id, the creation and snapshot times, the schema version, the source file's name, the plaintext's size and
  SHA-256, the data key's id and version; file times; how often backups are made (activity patterns).
- *A manifest:* the same facts and the ciphertext's SHA-256. The plaintext SHA-256 (asked for by R7-085's task) lets
  someone holding a plaintext copy, such as an old `.bak`, confirm which backup it matches; guessing a whole database
  from it is not feasible.
- *The keyring:* the key-encryption key's id; each data key's id, version, state and times.
- *The live database under volume encryption:* everything, to anyone who can read the mounted volume.
- *The live database under field encryption (section 5):* table and column names (`sqlite_master` stays plaintext), row
  counts, row and value sizes, identifiers, foreign keys, timestamps, indexes, which rows change and when, and equality
  of values that have a blind index.

## 2. Threat model

Encryption at rest protects data **at rest**: copies that leave the running system.

| Threat | Protected? |
|---|---|
| A copy of the backups (an off-site disk, a cloud bucket, a mistaken sync) without the key-encryption key | Yes: confidentiality and integrity. Alteration, truncation, a swapped file, an edited manifest and a header edited to another key version are each detected and refused (tests, section 6). |
| A stolen or retired disk of the machine or host | Yes for the live database only with FileVault or an encrypted volume (section 5); yes for backups. |
| A compromised running process (the API, the engine, or a dependency inside them) | **No.** It holds the keys and reads plaintext. Encryption at rest does nothing here; the authority boundary (passkeys, mandates, the vault) is what limits it. |
| Malware or another program running as the same macOS user | **No.** Mode 600 keeps other users out, not the same user: it can read the key file, the live database and process memory. |
| Root on the machine, or the host platform's operator (who can read environment variables and memory) | **No.** |
| Replacing newer backups with an older valid set (rollback) | **No.** Each set authenticates, so an older one is accepted. Detecting it needs a record of backup ids kept elsewhere, append-only (open item). |
| Deleting the backups | **No.** Needs a second, immutable copy off the host. |
| Sizes, timing and cadence | **No** (section 1). |
| A migration or `npm run reset` leaving a plaintext copy of the database beside it (24 Nov) | **Yes, from 24 Nov:** both seal under a key or refuse; nothing falls back to plaintext (`server/migration-copy.test.ts`, `server/backup-cli.test.ts`). The seven copies made before remain until the owner decides (section 7). |
| One key standing in for another: a backup key opening migration copies, a migration-copy keyring configured as the backup one, a keyring file relabelled (24 Nov) | **Yes:** each purpose has its own keyring and data keys; the purpose is authenticated and checked at every use (`key_purpose`, `keyring_tampered`; `server/key-separation.test.ts`). One KEK wraps all three keyrings through per-purpose derived keys, so whoever holds the KEK and the keyrings can open all of them: separation limits mistakes and misconfiguration, not a KEK compromise. |
| Removing the archived plaintext copies by mistake, or removing one that changed after it was archived, or a database that is open (24 Nov) | **Yes:** removal needs `--remove-plaintext` and the archive's id typed back, re-checks every original byte for byte against the archive, and refuses a database with a `-wal` or `-shm` beside it unless it was named as closed when archived; if any check fails nothing is removed (`server/plaintext-archive.test.ts`). |
| Recovering a removed plaintext copy from the disk | **No** beyond FileVault: on an SSD with APFS an unlinked file's blocks are not overwritten, and local snapshots may keep it. FileVault (on, 22 Nov) is what protects them at rest. |
| A seal, reset, restore, extraction or drill stopped part-way with plaintext on disk (review of `cb85271`, findings 1 and 4) | **Yes for SIGINT, SIGTERM, SIGHUP:** they wait for the synchronous step and its clean-up. **Partly for SIGKILL, a crash or a power cut:** the plaintext stays until the next operation of that kind in that place sweeps it (overwritten, removed, reported); `plaintext:scan` lists it meanwhile (`server/interrupt.test.ts`). |
| A guard passed by naming a file in another letter case, or through a link (finding 2) | **Yes:** files are compared by device and inode; folders by inode up the path; removal re-checks each original against the configured live database just before unlinking it (`server/path-identity.test.ts`). |
| An older keyring copy put back (it may still hold a revoked key); a revoke that misses copies elsewhere (finding 3) | **Yes for the keyring this tool keeps:** an authenticated generation and its record beside the keyring refuse an older copy; revoke covers every recorded folder, refuses while a recorded folder is unreachable, and rewrites every known keyring copy. **No** for copies made where this tool did not write (copied off the computer by hand): revoke names them as still holding the key. |
| An edited archive record steering removal (`archive.json`: paths, roots, databases named closed) | **Yes:** the record is sealed beside it and must match before verify, extraction, removal or re-encryption (`server/plaintext-archive.test.ts`). |

## 3. Key management (`server/keys.ts`)

**Hierarchy.** Data is sealed under a data-encryption key (DEK); DEKs are versioned in a keyring file, each wrapped
under one key-encryption key (KEK) that is held outside the database. Every key is 32 bytes from `crypto.randomBytes`.

**Cryptography: established primitives from node:crypto only (Verified on Node 26.12.0, OpenSSL 3.5.9).**
AES-256-GCM with a random 96-bit nonce per message and a 128-bit tag (`authTagLength` fixed at 16, so a shortened tag
is refused: a 12-byte tag raised `ERR_CRYPTO_INVALID_AUTH_TAG` in a probe); HKDF-SHA-256 derives two keys from the KEK, one to wrap DEKs and one for an HMAC-SHA-256 over the
keyring's metadata. XChaCha20-Poly1305 is not offered by node:crypto (`crypto.getCiphers()`), so it is not used. No
other construction. With random nonces one key may seal at most 2^32 messages (NIST SP 800-38D section 8.3): backups
use a handful a day; field encryption (section 5) must rotate the DEK well before that.

**Ciphertext header.** Every ciphertext begins `"QEDC" | format 1 | algorithm 1 | key version | key id | nonce |
plaintext length | metadata`, all authenticated, together with a context string the caller supplies (for a backup,
`qed/backup/v1:<backup id>`; for a field, the table, column and row). So the key id and version are in every
ciphertext; a header edited to name another version fails; a ciphertext moved to another purpose fails; anything that
is not a QED ciphertext is refused rather than passed through as plaintext.

**Providers of the KEK.** All three read the same one-line record, `qedkek1:<id>:<key>:<check>`; the check value
catches a truncated or mistyped key before use, and error messages never quote the record.

1. *Key file* (the default locally, and for a host's mounted secret). Checked at every load: owned by the service's
   user (or root), no permission bits for group or others (else refused with the `chmod 600` to run), its folder not
   writable by others unless sticky, and not inside the database or backup folders (`key_location`). Created mode 600
   in a folder of mode 700; never overwritten. A platform that mounts secrets group-readable needs an init step that
   copies the file with the right owner and mode, or the environment provider.
2. *Environment variable* (`QED_KEK`, set by a host's secret manager). Removed from `process.env` as soon as it is read,
   so child processes (the model's command-line client, for one) do not inherit it. Limits: the platform and anyone
   with root can read a process's environment; some platforms log variable changes.
3. *macOS Keychain:* an interface only (`KeychainBackend`, `KeychainKekProvider`). The system backend refuses every
   call with `keychain_not_enabled`; nothing reads or writes the owner's login Keychain until the owner decides.
   `server/keys-fake.ts` is the test double.

A managed key service (a KMS unwrapping a KEK at start, with access logged by the service) is the production step
beyond these; it needs an account and the owner's approval (D-070), and is not built (Hypothesis).

**Key separation (24 Nov).** Each purpose has its own keyring with its own data keys: `database` (D10's field encryption;
reserved: nothing is sealed under it yet, and `keys:init` does not make it), `backup` (backups, `npm run reset`, the
archives of plaintext copies) and `migration-copy` (the copies taken before a migration). A keyring of format 2 records
its purpose; the purpose is covered by the keyring's HMAC, so a relabelled keyring fails its integrity check
(`keyring_tampered`). The KEK's wrapping and HMAC keys are derived per purpose (HKDF info `qed/keyring/<purpose>/<use>/v2`),
and each data key is an independent random key whose id names the purpose (`dek_backup_<16 hex>`), so every ciphertext's
header says which purpose's key sealed it. Every use checks the purpose: a backup is made only under the backup keyring,
a migration copy only under the migration-copy one, and a restore uses the keyring of the copy's own purpose (else
`key_purpose`, before anything is decrypted). Each key's *check value* (16 hex digits of HMAC-SHA-256 under the key) is
shown by `keys:status` and `list`, so two keyrings can be compared without revealing a key; the test of separation
checks that the three purposes' values differ. Keyrings of format 1 (22 Nov) are still read, as backup keyrings, and
keep their format. What separation does not do: one KEK wraps all three keyrings, so whoever holds the KEK and the
keyrings can open everything; it prevents one key standing in for another by mistake or misconfiguration.

**Where the keys are found** (`server/key-config.ts`; the service, a migration and every command read the same):
`QED_KEY_DIR` (default `~/.qed/keys`, outside the repository and the data folder) holds `qed.kek` and
`<purpose>.keyring.json`; `QED_KEY_FILE` names the KEK file elsewhere, or `QED_KEK` carries it (not both: `key_config`);
`QED_KEYRING` and `QED_MIGRATION_KEYRING` name a keyring elsewhere; `QED_BACKUP_DIR` (default `~/.qed/backups`);
`QED_MIGRATION_COPY_DIR` (default `migration-copies/` beside the database). These defaults are a proposal: the key's
location and escrow are the owner's decision (section 7). `npm run keys:init` makes the KEK file (mode 600, folder 700)
and the backup and migration-copy keyrings, and on a second run only checks them.

**Generations and rollback (24 Nov, after the review).** Every change to a keyring (rotate, rewrap, revoke) raises its
`generation`, which the keyring's HMAC covers; the highest generation written is also kept beside it in
`<keyring>.generation`. A keyring whose generation is lower is refused at load (`keyring_rolled_back`), with both numbers
and the way to accept an older copy knowingly (remove the `.generation` record, only when no newer copy exists anywhere).
A keyring of format 1 becomes format 2 (purpose `backup`, generation 1) at its first change; its data keys are wrapped
again for it, and nothing they sealed changes. What this does not cover: someone who replaces the keyring *and* its
`.generation` record (an older copy of the whole key folder) is not detected; the KEK holder can always do that.

**Where copies are (24 Nov, after the review).** Each keyring records, in `<keyring>.places`, every folder where a set
was sealed under it, an archive was made, or a copy of it was written (best effort: a read-only key folder does not stop
a backup). `reencrypt --all`, `revoke` and `backup:verify` cover those folders as well as the defaults; a recorded folder
that cannot be reached (deleted, or a disk not mounted) fails `verify` and stops `revoke` until it is reachable again, or
is dropped with `node scripts/backup.ts forget --dir <folder> [--purpose <p>]` once its copies are gone for good. A copy
of one purpose's keyring is never written over another purpose's copy (`key_purpose`).

**Rotation.** `rotate` adds a DEK version that seals from then on; earlier versions are retired and still open what
they sealed. `rewrap` moves every DEK under a new KEK (KEK rotation): nothing sealed before is lost, and the old KEK
no longer opens the keyring. `revoke` destroys a retired version's material; it refuses the active version. Keyring
writes are atomic (a private temporary file, flushed, renamed). One writer at a time: these are operator commands.
*Since 24 Nov:* `rotate --purpose <p>` and `revoke --purpose <p>` act on one purpose's keyring and refresh its copy
beside the copies it sealed; `rewrap` (without `--keyring`) loads every keyring in the key folder first and re-wraps all
of them, or none; `reencrypt --all [--purpose <p>]` re-encrypts every copy (and, for the backup key, every archive) not
yet under the active version, stream to stream, so no plaintext reaches the disk; `revoke` refuses (`key_in_use`) while
any backup, migration copy or archive in the configured folders is sealed under that version and has no re-encrypted
successor; `backup:verify` then reports the old ones as superseded. Copies kept elsewhere (off the host) are not seen:
re-encrypt them before revoking. *After the review:* "elsewhere" now means outside the recorded folders (`.places`),
and after revoking, every known copy of the keyring is rewritten so that none still holds the revoked key.

**A host without the developer's Mac.** Backups carry a copy of the keyring (wrapped keys only, mode 600) in their
folder, so a fresh host needs two things: the backup folder and the KEK from its secret manager. The drill proves it
(section 6): host A's data and keys are deleted, then a separate process restores with only those two.

**Escrow.** Losing the KEK loses every backup, by design. Keep an offline copy of the key file (for example printed and
locked away, or in the secret manager's own backup), never beside the backups.

**Compromise response.**

1. *The KEK leaked* (a key file copied, a variable exposed): make a new KEK (`backup.ts rewrap --new-key-file`, or a new
   secret), which re-wraps the keyring; refresh every keyring copy (`--copy-to <backup folder>`); rotate the DEK too,
   since whoever had the old KEK and any keyring copy could unwrap the old DEKs; re-encrypt every backup
   (`backup.ts reencrypt`; since 24 Nov `reencrypt --all`, once per purpose, which also takes the archives); revoke the
   old versions (`backup.ts revoke [--purpose <p>] --version <n> --confirm`); destroy the old KEK, old keyring copies and
   old backup sets; record the incident and its times.
2. *A DEK leaked* (a memory dump of a process): rotate, re-encrypt, revoke.
3. *Backups were copied but the KEK is safe:* nothing is exposed; rotate anyway if where the KEK has been is uncertain.

The test "compromise response" runs steps 1's rotate, re-encrypt and revoke; afterwards the old backup fails closed
(`key_revoked`) and the re-encrypted one restores.

## 4. Backups and restore (`server/backup.ts`, `scripts/backup.ts`)

**Backup.** A connection that runs only `VACUUM INTO` makes a consistent copy, which includes the WAL, beside a running
service. It is an ordinary connection on purpose (section 1's probes: a read-only one leaves `-shm`/`-wal` behind, and
`query_only` refuses `VACUUM INTO`). The copy goes into an empty file made with mode 600 in a private temporary folder
(mode 700) on the database's own volume. Before any plaintext exists, a probe file is made and removed there; if that
fails the backup refuses to run (`temp_unavailable`). The temporary folder may not be inside the backup folder. The copy
is sealed in one AES-256-GCM message under the active DEK. Then the plaintext copy and its folder are removed and shown
to be gone; only then is the manifest written. If removal fails, the sealed file is deleted, no manifest is written, and
the error names the leftover path (`plaintext_left_behind`).

**Verified after writing (24 Nov).** Every sealed copy (a backup, a migration copy, a re-encryption, an archive entry) is
sealed into a partial file, read back and decrypted in memory, and must give exactly the plaintext's SHA-256 and length,
and still be the bytes that were written; only then is it renamed into place and the plaintext removed. If the check
fails, the partial is deleted and nothing is recorded (`verification_failed`). A test alters the partial between writing
and checking and the check catches it (`server/migration-copy.test.ts`).

**Migration copies (24 Nov; `server/migration-copy.ts`, `server/sealed.ts`).** When `openDb` finds a database at an older
schema version, before anything changes it seals a copy: the keys are loaded first (KEK, then the migration-copy keyring,
which must be of that purpose), so a missing or wrong key refuses before anything is read or written; then `VACUUM INTO` a
private temporary folder beside the database, a check that the copy is at the version the migration starts from and
passes SQLite's `quick_check`, the seal under the migration-copy key, the read-back check, the removal of the plaintext,
and a manifest that records `migration: { from, to }`. The copies go into `migration-copies/` beside the database (mode
700, with a copy of the migration-copy keyring). Any failure throws `MigrationRefused`: the migration does not run, the
connection is closed, and `server/main.ts` prints the reason and the fix (no stack trace) and exits 1. A database that an
earlier QED start has opened is left byte for byte as it was, and so is a write-ahead log still waiting from a start that
was killed (closed through a read-only connection so that nothing checkpoints it; the `-shm` index may be rewritten;
review finding 5); one that never was opened (made by `VACUUM INTO`, in rollback mode) has its journal mode switched to
WAL by the open itself, which rewrites four header bytes and no data (probe, 24 Nov). If the database has not changed
since its newest migration copy (same snapshot SHA-256), that copy is checked again and reused instead of a new one, so a
migration that keeps failing after its copy does not pile copies up across restarts.

**Scratch folders and signals (after the review).** Plaintext exists on disk only in private scratch folders that record
their owner: a seal's snapshot (`.qed-backup-*` beside the database), a restore (`.qed-restore-*` beside its target,
moved into place when it has verified), an extraction (`.qed-extract-*`), a drill (`$TMPDIR/qed-drill-*`). Sealed
files are written in `.qed-sealing-*` and archives built in `.qed-archiving-*` (ciphertext only) and moved into place
whole. The entry points take SIGINT, SIGTERM and SIGHUP before anything is opened, so a signal waits for the step under
way and its clean-up; the next operation of the same kind in the same place sweeps what a SIGKILL left (section 2). Restoring a migration copy over the live database (a rollback) needs the backup key too, to back the current
one up first. With the keys in place the step adds little: on a copy of the review database's pre-v5 file (18.6 MB, schema
4), the copy took 184 ms (copy 78, seal 65, check 37) before the migration to 5 ran and `verify` passed.

**Manifest** (`<id>.manifest.json`, mode 600, in a backup folder of mode 700): format, id, file, creation and snapshot
time, schema version, source file name, `AES-256-GCM`, the DEK's id and version, size and SHA-256 of the plaintext and
of the ciphertext. The same facts sit in the sealed file's authenticated header, so an edited manifest is detected.

**Restore** checks, in order, before decrypting: the manifest's form (and that it names its file by id, never by a
path); the file's size and SHA-256; that the manifest agrees with the authenticated header; since 24 Nov, that the
keyring is of the copy's purpose (`key_purpose`). Then it decrypts, streaming,
into a private file beside the target; GCM releases plaintext before its tag is checked, so that file is deleted unless
the tag verifies. It checks the plaintext SHA-256, then verifies on a read-only connection: `PRAGMA integrity_check`,
`PRAGMA foreign_key_check`, the schema version, and for every workspace `verifyLedger` (`server/ledger.ts:190`) and
`verifyChain` (`server/receipts.ts:41`), the checks of `npm run verify`. It reports each step's time.

**The live database is written only with `--overwrite-live`.** The live path (default: the configured database) needs
the flag whether or not a file is there yet. With it, the restore refuses while a `-wal` or `-shm` file shows the
database may be open (`live_in_use`), backs the current live database up encrypted first (`--backup-live-to`),
replaces it only if the restored copy verified, and refuses if the live file was opened meanwhile. No other existing
file is ever written over (`target_exists`).

**Commands (24 Nov),** run from `apps/qed-demo`, with the defaults of section 3 (each prints no key; exit 1 with an error
code on any refusal, 2 on a usage error):

```
npm run keys:init                      # once: qed.kek (mode 600) and the backup and migration-copy keyrings; then escrow qed.kek
npm run keys:status                    # where the keys are; each keyring's versions, states and check values; counts of copies
npm run backup                         # seal data/qed.db (QED_DB) into ~/.qed/backups (QED_BACKUP_DIR), beside a running service
npm run backup:verify                  # every backup, migration copy and archive decrypted in memory and checked; keyring copies
npm run backup:drill                   # newest backup -> private scratch folder -> `node server/main.ts verify` -> removed
npm run restore -- --manifest <m> --target <new path>          # a backup or a migration copy, by its purpose
npm run restore -- --manifest <m> --target data/qed.db --overwrite-live --backup-live-to <dir>   # services stopped first
node scripts/backup.ts rotate [--purpose backup|migration-copy]
node scripts/backup.ts reencrypt --all [--purpose backup|migration-copy]
node scripts/backup.ts revoke [--purpose …] --version <n> --confirm
node scripts/backup.ts rewrap --new-key-file <path>             # every keyring in the key folder, or none
node scripts/backup.ts forget --dir <folder> [--purpose …]       # a recorded folder whose copies are gone for good
npm run plaintext:scan                 # the plaintext database files beside the database, and which an archive records
npm run plaintext:archive              # seal the recorded qed.db.….bak copies; originals left in place (-- --dir/--file for others)
node scripts/plaintext-copies.ts verify  --archive <dir>
node scripts/plaintext-copies.ts extract --archive <dir> --entry <n> --target <new path>
node scripts/plaintext-copies.ts remove  --archive <dir> --remove-plaintext --confirm <archive id>   # only once the owner decides
```

The forms of 22 Nov are still accepted (`init-key --key-file`, `init --keyring`, any command with `--keyring`,
`--key-file` or `--key-env`), as is `node scripts/restore-drill.ts` (re-run 24 Nov: 13 of 13 checks).

None of these was run against the review database or its data folder; the rehearsal of section 6 used copies.

## 5. The live database: decision and plan

node:sqlite has no SQLCipher. Three ways to protect the live file:

| | A. Full-disk or volume encryption | B. Application field encryption | C. A SQLCipher-capable driver |
|---|---|---|---|
| Covers | the whole volume: database, WAL, free pages, logs, `.bak` files, everything | chosen columns only; not the WAL's old frames or free pages until vacuumed | every page of the database and its WAL |
| Against a stolen disk | yes | for those columns | yes |
| Against a copied file (by someone who is not root or the user) | no: plaintext to any reader of the mounted volume; file modes are the defence | yes, for those columns | yes |
| Against a compromised running process | no | no | no |
| Cost | none locally (FileVault: **Verified on**, `fdesetup status`, 22 Nov); hosted: the provider's encrypted volume (Hypothesis: the intended host's volume encryption is not checked; D-070 bars touching Railway) | every reader and writer of those columns changes; lookups need blind indexes; a migration | the database layer moves off node:sqlite (`server/core.ts:3`: no native add-on today) to a native add-on |
| Supply chain | none | none (node:crypto) | a native binary or a C build in the install path; small maintainer base (Hypothesis) |

**Recommendation: A now, with the encrypted backups built here and the file-mode fixes; B before any production use;
C only if the database layer leaves node:sqlite for other reasons.** A costs nothing and covers the stolen-disk case
today. B is what protects the most sensitive values in a copied database file, and it is pure node:crypto. C protects
every page but brings a native dependency into a build that has none, a week before the final (29 Nov).

**C's candidates (Hypothesis: from prior knowledge, not checked on 22 Nov; no network lookup was made):** better-sqlite3-
multiple-ciphers (MIT; wraps SQLite3MultipleCiphers, MIT, which reads SQLCipher's format) and @journeyapps/sqlcipher
(SQLCipher Community Edition, BSD-style). Both are native add-ons; the key is set with `PRAGMA key` and lives in the
process, so the compromised-process limit is the same. Licence, maintenance and the provenance of prebuilt binaries
must be checked before adoption (`docs/setup/THIRD_PARTY_MATRIX.md`).

**B, the columns** (in order of sensitivity): `conversation_turns.question`, `answer`; `ai_calls.question`,
`output_json`, `sent_json`; `payees.name`, `payees.handle`; `bills.memo`; `earn_jobs.client`; `users.display_name`,
`profile_json`; `audit.ip`; `sessions.ua`; `security_events.detail_json`. Not `receipts.body_json` for now: the hash
chain covers the canonical body and the browser re-verifies it (`server/receipts.ts:1-6`); encrypting it means
verifying after decryption, a design change of its own. Not the passkey public keys: they are needed for every sign-in
and are public by nature.

**B, the query impact.** An encrypted column cannot be compared, sorted, searched or indexed. Two lookups need a
blind index (HMAC-SHA-256 under a key derived by HKDF from the keyring, separate from the sealing keys):
`payees UNIQUE (user_id, handle)` becomes `UNIQUE (user_id, handle_bidx)`; and `users.handle`, if it is ever encrypted,
needs one over the case-folded handle for sign-in (`COLLATE NOCASE`). A blind index reveals which rows share a value.
Each field costs one AES-GCM operation (microseconds); the cost is code in every reader and writer.

**B, the migration** (schema v4, with a backed-up copy):
1. Take an encrypted backup with this tool and drill it (`restore-drill.ts --manifest`).
2. Add `<column>_enc BLOB` (and `<column>_bidx` where a lookup needs it).
3. Backfill in batches inside transactions; each value's context is `qed/field/<table>.<column>:<row id>`.
4. Verify: every row decrypts to its plaintext column; every `_enc` value parses as a QED ciphertext.
5. Switch readers and writers to the encrypted columns.
6. Clear the plaintext columns, set `PRAGMA secure_delete = ON`, `VACUUM`, `PRAGMA wal_checkpoint(TRUNCATE)`: until
   then free pages and WAL frames keep the old text (section 1's probe).
7. With the owner's approval, destroy every plaintext copy: the five `.bak` files, `scratch-backup-20261120/`.
8. Make the migration's own backup encrypted (`server/core.ts:185-189` writes a plaintext `.bak` today; patch in the
   hand-back), or the next migration writes a fresh plaintext copy.
   *24 Nov:* step 8 is done (migration copies are sealed or the migration refuses; section 4). For step 7 the tools
   exist (`plaintext:archive`, `verify`, `remove`), there are seven `.bak` files now, not five, and the decision is
   still the owner's (section 7).

Risks: losing the KEK loses those columns (escrow, section 3); a bug writing plaintext into an `_enc` column (caught by
step 4's check, kept as a test); nonce limits (rotate the DEK at, say, 2^30 field encryptions).

## 6. Availability targets and the measured drill

**Proposed objectives.**

| | Local build (review and demonstration) | Hosted deployment |
|---|---|---|
| RPO (acceptable data loss) | 1 hour: an hourly encrypted backup (a LaunchAgent; not installed, needs the owner's approval), plus one before every migration and every `npm run reset` | 15 minutes with periodic backups to separate, versioned storage; under 1 minute would need continuous WAL shipping by a vetted tool (not evaluated) |
| RTO (time to restore service) | 15 minutes: stop the services, `backup.ts restore --overwrite-live`, start them, `npm run verify` | 1 hour: provision, fetch the backup, the KEK from the secret manager, restore, verify, reconnect the chain, reconcile |
| Drill | after every key rotation, and monthly on the newest real backup (`restore-drill.ts --manifest`) | the same, on a scratch host |

The measured technical restore (below) is a fraction of a second, so these objectives are set by people and
provisioning, not by the tool. (Hypothesis: on-chain activity after the last backup can be recovered by reconciling
with the chain; not tested. The vault service's `rail.db` and co-signer key file are not covered by this tool yet.)
Monitoring is not built: it should alert when the newest manifest is older than the RPO, when a backup or a drill
fails, and when the backup volume is nearly full.

**RPO and RTO of local backups as they stand on 24 Nov (assumptions stated).**

- *RPO.* No schedule is installed (owner decision, section 7). Until one is, what can be lost is everything written since
  the last `npm run backup`; a migration copy is taken only at a schema migration and is not a schedule. With the
  proposed hourly backup the RPO is 1 hour plus however long a failing backup goes unnoticed (no monitoring yet), and only
  while the Mac is awake: a sleeping or switched-off laptop takes no backup (R11 section 11). It assumes the backup folder
  survives the incident (today it is on the same disk: losing the disk loses both; an off-host copy is an owner
  decision), the KEK or its escrow copy survives, and on-chain activity after the snapshot is recovered by reconciling
  with the chain (Hypothesis, untested).
- *RTO.* The proposed 15 minutes assumes someone is at the machine: stop the services, `npm run restore -- --manifest
  <m> --target data/qed.db --overwrite-live --backup-live-to <dir>`, start them, `npm run verify`. The tool's part is
  seconds (below); the rest is people noticing, deciding and restarting. Not measured: a restore of the real data on a
  second machine (the 22 Nov drill did that on fixtures), and any restore of the vault service.

**Measured (Verified, 24 Nov 2026, the same Mac under a load average of 26 on 10 cores from other sessions, so not
comparable with 22 Nov's figures):** `node scripts/restore-drill.ts` on the new code: 13 of 13 checks, recovery 3.08 s
(344 ms on 22 Nov). A rehearsal on copies of the review machine's data (plain copies of the seven recorded `.bak` files
and of `scratch-backup-20261120/`, checksums equal to the originals, and a `VACUUM INTO` copy of the live database made
with `sqlite3 -readonly`; in a private scratch folder with keys made there):

1. `plaintext:scan` found the seven recorded copies, and in the scratch folder four more database copies and two
   databases with leftover journal files.
2. `plaintext:archive`: the seven copies (64.5 MB) sealed and each checked byte for byte in 6.5 s; `verify`: 7 of 7
   identical, 1.0 s. The scratch folder was refused (two databases with a `-wal` or `-shm`) until both were named with
   `--assume-closed`; then 3,249 entries (93.0 MB) in 50 s, verified 3,249 of 3,249 in 8.8 s.
3. The pre-v5 copy, extracted from the archive (SHA-256 equal to the original's) and opened by this code: its migration
   copy was sealed and checked in 184 ms, the migration to v5 ran, and `node server/main.ts verify` passed for both
   workspaces.
4. `npm run backup` of the 21.6 MB live copy: 2.0 s wall (copy 706 ms, seal 96, check 188); `backup:verify`: 3 of 3
   sealed sets (the backup and both archives), 12.5 s; `backup:drill`: passed, 6.1 s wall (restore 1.06 s, then
   `node server/main.ts verify` exited 0); `restore` to a new path, then `node server/main.ts verify`: consistent, intact.
5. Rotation: `rotate`; `revoke` refused while three sets still needed version 1; `reencrypt --all` re-sealed the backup
   and both archives (3,256 entries) stream to stream in 19.7 s; `revoke` then passed and `backup:verify` reported the
   old sets superseded and the new ones verified. The same for the migration-copy key.
6. Leakage: the 3,269 files written (201 MB: every sealed file, manifest, keyring and archive record) were searched for
   30,641 distinct 32-byte samples, one from the end of each page of the 15 plaintext databases (31,546 pages), at every
   offset: none found; no SQLite header in any of them; every sealed file incompressible (lowest deflate ratio 1.0003).
   Positive control: the same search finds 8,684 samples in the plaintext pre-v5 copy and 13,202 in the live copy.
7. Removal, of the scratch copies only: refused without `--remove-plaintext` (exit 2) and with a wrong id (exit 1); with
   both, the seven copies were removed after the byte-for-byte check and a removal record was written; the pre-v5 entry
   still extracted to the original's SHA-256 afterwards.

The scratch folder, which held plaintext copies, was deleted afterwards. The review data folder was not changed: the
seven copies have the same SHA-256 as before and no file appeared there.

**Measured (Verified, 22 Nov 2026, this Mac: Node 26.12.0, SQLite 3.54.0, OpenSSL 3.5.9, arm64; isolated fixtures):**

| Drill | Database | Backup (copy + seal + manifest) | Restore work (checks, decrypt, verify) | Restore process (wall) | `npm run verify` on the restored file | Recovery measured |
|---|---|---|---|---|---|---|
| default: 6 workspaces, 9,000 entries and receipts | 10.3 MB | 60 ms (copy 24, seal 18) | 80 ms (4, 13, 63) | 145 ms | 199 ms | **344 ms** |
| larger: 12 workspaces, 72,000 | 78.4 MB | 240 ms (copy 116, seal 102) | 613 ms (28, 56, 529) | 692 ms | 467 ms | **1.16 s** |

These are the runs on the final code (17:19 IST); two earlier runs of the same drills on 22 Nov were within 10% of them
(333 ms and 1.18 s).

Each drill passed 13 of 13 checks: backups taken beside an open service connection; host A deleted; host B restored the
newest backup in a separate process with the key in its environment only; the application opened the restored file and
`npm run verify` passed for every workspace; the write made after the newest backup was absent (the RPO in action)
while the earlier one was present; the older backup, under the retired version, restored through the re-wrapped
keyring; the old KEK was refused (`wrong_key`); a truncated copy (`backup_truncated`), an altered copy with its manifest
re-hashed (`authentication_failed`), a restore over the live file without the flag (`would_overwrite_live`) and a
missing key (`key_missing`) were refused with nothing written; no sensitive value or key appeared in any backup file,
manifest, keyring copy or output; and the restored file did hold every sensitive value (the positive control). Command:
`node scripts/restore-drill.ts --out <report.json>` (and `--households 12 --entries 6000`). Verification time grows
with the number of receipts and postings; decryption with size.

**Tests (Verified):** `npx vitest run server/keys.test.ts server/backup.test.ts`: 33 passed. Two deliberate mutations
were each caught and then reverted: ignoring the GCM tag (2 key tests failed) and not refusing a leftover plaintext copy
(1 backup test failed).

**Tests (Verified, 24 Nov):** the seven files listed at the top. Eight deliberate mutations, each caught by a failing test
and then reverted: skipping the check after writing; skipping the removal's confirmation; a keyring that never refuses
another purpose; `openDb` swallowing a refused copy and migrating anyway; the byte-for-byte comparison always saying
"identical"; a silent fallback to a plaintext `.bak` when the key is missing; leaving the plaintext snapshot behind; and
`revoke` ignoring the archives.

## 7. Open items

**Owner decisions (24 Nov), as questions.** Until they are answered, nothing in this work acts on the review machine.

1. **Key location.** Is a key file at `~/.qed/keys/qed.kek` (mode 600 in a folder of mode 700, FileVault on) acceptable
   for the local build, or should the macOS Keychain provider be enabled instead (it reads and writes your login
   Keychain)?
2. **Escrow.** Where is the offline copy of the key-encryption key kept (printed and locked away, a password manager, a
   second encrypted disk), and who may use it? Without the key, every backup, migration copy and archive is lost.
3. **Keys on the review machine, and when.** May `npm run keys:init` be run there now (after questions 1 and 2)? Until
   it is, the next schema migration (the v6 work in progress) refuses to run, so the API and the engine on that code stop
   at start with the reason, and `npm run reset` refuses.
4. **Schedule and retention.** Should an hourly encrypted backup run (a LaunchAgent calling `npm run backup` then
   `npm run backup:verify`; RPO 1 hour while the Mac is awake), and how many should be kept (proposal: 48 hourly and
   30 daily)? How long should sealed migration copies be kept (one per migration; QED never deletes one)?
5. **Off-host copy.** Should sealed backups also be copied off this computer (an external disk, or a cloud bucket, which
   is a paid service needing your approval), and should that copy be immutable (object lock), so that deletion and
   rollback can be detected?
6. **The plaintext copies.** Once `npm run plaintext:archive` has sealed them and `verify` has passed, may the seven
   `qed.db.….bak` files be removed (`remove --remove-plaintext --confirm <archive id>`), or must they stay in plaintext
   until a given date? The same for `scratch-backup-20261120/` (it holds four more database copies and two leftovers) and
   `rail-baseline-20261120/`. How long should the archives themselves be kept?
7. **The vault service's data.** Should `data/rail/master.key` (the vault host's master secret, plaintext, mode 600) and
   the vault database be backed up under the backup key, and should the master key be wrapped under the KEK at rest? A
   consistent vault backup needs the vault service quiesced (its `rail.db`, its Anvil state file and the in-memory chain
   change independently); not built, so no backup or restore of the vault is claimed.

**Engineering still open:** field encryption of the live database's sensitive columns under the `database` keyring
(section 5, before any production use); monitoring (the newest backup older than the RPO, a failed backup, verify or
drill, a nearly full backup volume); rollback detection (backup ids recorded elsewhere, append-only); file modes outside
this work (`data/` 700; `rail.db*` and the logs 600; `data/rail/` 700); `apps/qed-demo/README.md` still describes
`npm run reset` as moving the database aside (outside this change's files).

**22 Nov list (kept as written; superseded where marked):**

- Owner decisions: the Keychain provider; where the local KEK lives and how it is escrowed; an hourly LaunchAgent;
  removing the five plaintext `.bak` files and `scratch-backup-20261120/` once an encrypted backup exists. *(Now
  questions 1, 2, 4 and 6 above; there are seven `.bak` files.)*
- File modes outside this work (other specialists' files): `data/` should be 700; `rail.db*` and the logs should be
  600 (`chain/rail/store.ts` sets no mode); `data/rail/` 700.
- Wiring (patches in the hand-back): migrations and `npm run reset` should make encrypted backups instead of plaintext
  copies; the keyring and file-mode checks should run when the API and the engine start, once field encryption exists.
  *(Done 24 Nov for migrations and `npm run reset`; the check at start still waits for field encryption.)*
- Rollback detection for backups: a record of backup ids kept elsewhere, append-only.
- Backups of the vault service's database, co-signer keys and master secret; wrapping `master.key` and `cosigner.key`
  under the KEK (they are plaintext at rest today, protected by mode 600 only). *(Question 7 above.)*

## 8. The research environment's rollout (24 Nov 2026, R12; the owner's authorisation in R12 section 5)

**Keys.** `npm run keys:init` made the key-encryption key `kek_be39852ab0d42141` as the file `~/.qed/keys/qed.kek`
(mode 600 in a folder of mode 700, outside the repository and every data folder, on a FileVault disk) with the backup
and migration-copy keyrings (checks f6f6fa8c823ad127 and 1ff534378fe248bf). No command printed a key.
**Escrow.** A copy of the key's record is held in the owner's login Keychain as a generic password, service "QED research
key-encryption key (escrow)", account `kek_be39852ab0d42141`; it was written through `security`'s prompt on standard
input, never on a command line, and checked by fingerprint (ed20620bc5855c5d) without printing it. Each archive and the
backup folder carry their own wrapped keyring, so the escrow copy alone opens them: rehearsed by restoring one entry of
each archive with only the Keychain copy and the archive's keyring (byte-identical by SHA-256, integrity ok).
**Archives.** `ar-20261124T070436Z-6462b5`: the seven `qed.db.….bak` migration and reset copies (63.5 MB);
`ar-20261124T070441Z-3eb754`: `scratch-backup-20261120/` and `rail-baseline-20261120/` (3,258 files, their leftover
databases named closed after `lsof` showed no process holding them). Both verified entry by entry against the originals.
**Removal.** After that verification and the two restores, the originals were removed with
`plaintext-copies.ts remove --remove-plaintext --confirm <id>`, which re-checked each one just before unlinking it; the
records are beside each archive. Removal on APFS is not erasure: the freed blocks are protected by FileVault, not
overwritten. `plaintext:scan` now finds no copy beyond the two live databases.
**Backups.** `bk-20261124T070532Z-61572e` of the live database, verified; `backup:drill` restored it and
`node server/main.ts verify` passed on the restored copy (two ledgers consistent, 59 receipts intact).
**The v6 migration.** Rehearsed on a fresh read-only `VACUUM INTO` copy of the review database: 16 of 16 checks, the
rollback under the review build's code (bf5e813) included (`evidence/20261124-r12-review-db-v6-rehearsal.json`).
The review database itself migrates when its services restart on the merged code, with a sealed copy first.
**Still plaintext by design:** the live databases (`data/qed.db`, the wallet service's `data/rail.db`), the wallet
service's master key (`data/rail/master.key`; its backup under the backup key waits for the service to be stopped),
and `data/review-account.json`, the review account's password kept by the owner's decision D-098 (not a database copy).

## 9. The wallet service's secrets sealed at rest (24 Nov 2026, R12 section 5)

This settles the wrapping half of question 7 (section 7) for the research environment, under the owner's authorisation
in R12 section 5 ("choose and implement the safest appropriate approach for local research key storage"). It does not
reach production keys, live accounts or any external credential. The first version (`09db70b`) was reviewed
independently before it touched the review build; its one high and four medium findings are fixed as described here
(the review's ids in brackets), and a re-check of those fixes (`d67c514`) found one more high and two medium faults in
them, fixed in turn (ids N-1 to N-6).

**What.** The wallet service keeps two secrets: `master.key`, the host's master secret (every host key and every
workspace's deployer, agent, guardian and relayer key is derived from it by HKDF), and `cosigner.key`, the separate
co-signer process's own keys per workspace and version. With sealing on (`QED_RAIL_SEAL=1`) each is kept only as
`<file>.sealed`: one AES-256-GCM message under the active data key of a fourth keyring purpose, `wallet-secret`
(`~/.qed/keys/wallet-secret.keyring.json`; key separation from the backup and migration-copy keyrings), bound to the
file's name (`chain/rail/sealed-at-rest.ts`).

**Recoverable without the key folder [H-1].** A copy of the `wallet-secret` keyring, wrapped by the key-encryption key
like every keyring copy, is kept beside the sealed secrets (`data/rail/keyring.json`, the name every keyring copy has, refreshed at each
sealed start and after every seal) and goes into every wallet-service archive. The escrowed key-encryption key (section 8) and any one of those
copies made since the last rewrap open the sealed secrets: rehearsed in `server/wallet-sealing.test.ts` with the key
folder's keyring deleted. If the key folder's keyring is lost, the wallet service refuses to start and names the copy;
`node scripts/wallet-sealing.ts restore-keyring` puts it back after checking it opens. The review build's `prepare` never
makes a new keyring for secrets that are already sealed (it stops and points to `restore-keyring`); `npm run keys:init`
does make one when it finds none, but the copy beside the sealed secrets is never replaced by a keyring that lacks one
of its data keys, the wallet service then refuses to start and names the copy, and `restore-keyring` asks for the new
keyring to be moved aside first [N-1; final pass F-1, F-3]. A rotation of the key-encryption key (`backup.ts rewrap`) re-wraps this
keyring with the others and refreshes its recorded copies; a service still running with the keyring from before never
writes its older copy over the newer one [N-4]. Copies inside archives made before a rewrap stay wrapped under the
previous key: keep that key's escrow until those archives are no longer needed. `backup:verify` checks an archive's
outer layer; that a sealed secret inside it opens with the archived keyring copy is not checked by it.

**When the review build seals [M-2, N-6].** `scripts/review-build.sh start` (and `restart`) first archives the stopped
wallet service's files under the backup key, exactly as it left them, then runs `wallet-sealing.ts prepare`, and seals
only if both succeeded. `prepare` never makes a key-encryption key (that is `npm run keys:init` and its escrow, the
operator's step) and makes only a missing `wallet-secret` keyring, never one for secrets already sealed. Without a key,
or if the archive fails, the wallet service starts with its secrets as they are, and says so. The script then waits for
the wallet service to report ready and shows the reason if its start was refused.

**Order.** A write goes to `<file>.sealed.partial` (mode 600, exclusive), is read back and decrypted, compared with what
was meant, synced, then put in place: a new secret by a hard link that fails if a sealed file already exists (so two
first starts on one folder cannot both make one; the data folder must support hard links, as APFS does, and so does
the folder's lock, without which neither the service nor the rollback runs there [N-5]), a replacement by rename. A plaintext secret found while sealing is
on is checked for form first (a malformed one is refused and left as it is), sealed that way, and removed only after
the sealed file has been read back equal. A new secret with sealing on is never written in plaintext. After a rotation
of the `wallet-secret` keyring the next sealed start re-seals under the active version. "Synced" means fsync(2): on
macOS that does not force the drive's own write cache (F_FULLFSYNC, which Node does not expose); removal on APFS is
not erasure.

**Failing closed [M-4].** A sealed file is always read sealed. Without the key-encryption key or the keyring, the
wallet service does not start, writes no plaintext and removes nothing. Its genesis now records a check value of the
master secret (a domain-separated SHA-256 prefix, not the secret; recorded on first start for a chain made before):
once the chain exists, a missing master secret is refused rather than replaced by a new one, and a different one (a
planted or swapped file) is refused rather than used. A plaintext file beside its sealed file must hold the same bytes
or nothing is read; it is removed only while sealing is on, since with sealing off it may be a rollback in progress.

**One user of the folder at a time [M-3, N-2, N-3].** A wallet service that seals, or reads sealed secrets, takes the
rail folder's lock (`data/rail/sealing.lock`, its pid) before it starts its chain, and holds it until it stops.
`wallet-sealing.ts seal`, `unseal` and `restore-keyring` take the same lock and also refuse while the chain's pid or the
service's port is in use. The lock file is written whole and then linked into place, so it is never read empty; a lock
whose process is gone is moved aside and removed only if it is still that process's, so two processes taking over one
dead lock cannot both hold it. Residual: a third process locking in the instant between a takeover's move and its
put-back. With sealing off and nothing sealed there is no lock, as before.

**Not offered [M-1].** `scripts/backup.ts` manages the backup and migration-copy keyrings only: a keyring given with
`--keyring` must be of the purpose asked for, so the `wallet-secret` keyring cannot be rotated or revoked through it
(tested). Its rotation happens only by re-sealing at a sealed start; revoking one of its versions is not built.

**Off unless asked for.** Sealing is on only with `QED_RAIL_SEAL=1` in the environment; tests and fixture stacks do not
set it (nothing forces it off: a runner with it set would seal under the configured keys), so they keep plaintext files
of mode 600 as before. The operator's `seal` checks each secret's form before sealing it, as the service does.

**Rollback.** Stop the review build (`scripts/review-build.sh stop`), then
`node scripts/wallet-sealing.ts unseal --confirm`: each plaintext file back byte for byte, synced and read back equal
before its sealed file is removed; start the wallet service without `QED_RAIL_SEAL`. Independently, every review-build
start archives the stopped wallet service's files under the backup key (`~/.qed/backups/wallet-service`) before anything
else (unless the archive itself fails, in which case nothing is sealed), the plaintext `master.key` of before the rollout
included, and, after it, the sealed files with the keyring's copy.
`node scripts/wallet-sealing.ts status` reports each secret's state, key version and a fingerprint (a domain-separated
SHA-256 prefix, never the secret) to compare before and after.

**Evidence.** `server/wallet-sealing.test.ts` (15 tests: seal and remove; never plaintext when new; refusal without the
key; interrupted migration both ways; name binding (authentication fails); re-seal after rotation; the co-signer's
file; unchanged when off; the rollback; recovery from the keyring copy with the key folder's keyring gone; no second
first secret; a missing secret refused once the chain exists; a malformed secret refused before sealing; an equal
plaintext left alone with sealing off; the folder lock); `server/backup-cli.test.ts` (the `--keyring` purpose check);
`chain/test/sealed-at-rest.test.ts` on the real service process with the co-signer in its own process: a plaintext
master secret sealed at start, the co-signer's keys created sealed, the keyring's copy beside them and the folder
locked while running, the same operator, co-signer, guardian, vault and owner-account addresses after a restart, a
different and then a missing master secret each refused with nothing made in its place, the right one restored and
working, and no start without the key-encryption key.

**Limits.** The name binding covers the file's name, not its folder: another rail folder's `master.key.sealed` opens in
its place, but the genesis check refuses it; an older `cosigner.key.sealed` put back opens, and the chain's check of
its registered co-signer then refuses a workspace whose key it lost [L-1]. Until R13 the co-signer process opened its
own sealed keys, so with the key-encryption key in the environment (`QED_KEK`, read once and removed) it could not and
failed closed. Since R13 the wallet service opens `cosigner.key` itself and hands its bytes to the co-signer over an
inherited pipe, storing the keys the co-signer makes when it sends them back; the co-signer's process is given no key
setting (`docs/LEAST-PRIVILEGE.md`; `chain/test/cosigner-key-pipe.test.ts`, with the key file). That `QED_KEK` now works for
the co-signer's keys too follows from the wallet service holding the keyring it opened at start: NOT VERIFIED by a test.
The wallet service holds the key-encryption key while it runs, as the API does, so a process of the
same user can still read the secrets; this keeps them out of the data folder, its copies and any copy of the repository
folder. A separate user, machine, HSM or KMS remains a production matter (baseline L-01).

**Still plaintext after this section:** the live databases (`data/qed.db`, `data/rail.db`; field encryption under the
`database` keyring is not built), the wallet service's bearer token `data/rail.token` (a local credential between the
API and the wallet service), `data/review-account.json` (D-098), and the logs.
