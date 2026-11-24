# Least privilege, tenant isolation and secret isolation, per process

Written 24 November 2026 for R7-075; section "R13 review fix F3" added 25 November 2026. Every statement here is about this
local build, where every process runs as one operating-system user on one computer, unless it names the container image. Locally
**no process is isolated from another by the operating system**, so a compromised process running as that user could read any
file that user can read. In the container image (since the R13 review fix F3) the co-signer alone runs as a second user; see the
section below, whose container statements are NOT VERIFIED on this computer (it has no container runtime) and are checked on
the built image by `scripts/deploy/isolation-check.ts`. Machines, a KMS or an HSM are a production matter (`SECURITY.md`
section 6; baseline L-01 in `chain/rail/cosigner-main.ts`).
What the code does enforce is who is *given* what, and which records a request can reach. Labels: Verified (a test or the cited
code shows it), NOT VERIFIED (stated by a comment or a document, not checked here).

## Tenants

A tenant is a workspace: a person's household or a business (`users.kind`). Every financial record is keyed by the workspace
(`user_id`); every request is resolved to (person, workspace, role) before a handler runs (`server/api.ts`, where the session's
chosen workspace is used only while the person is still a member, else their own). A member who reads a workspace that is not
their own leaves an entry in its access log. The vault service keeps one key scope per workspace (the co-signer's signing keys
are one 32-byte key per workspace scope and key version).

**Verified:** `server/tenant-isolation.test.ts` signs up two people over HTTP; one has a household and a business with a payee,
a bill with a memo, a signed approval, the action it made, an instruction draft and the business's own payee. The other then
sends 4,844 requests through every route the API registers (281 routes in 58 classes, 29 left out with reasons stated in the test),
using every identifier of the first person's that the first person's own reads revealed (42), with every method, and with those
identifiers in every body field. Nothing of the first person's comes back (identifiers, payee, memo, business name), and a digest of
every table row that belongs to either of the first person's workspaces is the same before and after. The other person's
request to switch into the first person's business is refused. The sweep reads the route list from the source of `api.ts`, so a
route added later is covered, and the test fails if a class of route went unvisited.

Not covered by that test (NOT VERIFIED): routes that need a running vault service (the API answers 503 for them without one, so
their handlers' scoping is exercised only up to that answer; the vault service's own workspace scoping is tested in
`chain/test/workspaces.test.ts` and `chain/test/hazards.test.ts`); the routes left out (sign-up, sign-in, recovery and
sessions), which are open to a person by design and have their own tests; and anything below the API (a person with the database file).

## What each process is given

| Process | Started by | It holds or reads | It is not given | Evidence |
|---|---|---|---|---|
| **API** (`node server/main.ts api`) | the operator | the database (read and write); the session secrets it makes; the vault service's token file (`rail.token`, to call the service); the migration-copy keyring when it migrates a database | the co-signer's key file; the wallet-secret keyring is read by the vault service, not by the API; no model credential is sent to any other process | `server/main.ts`; `server/rail.ts` (`railToken`); `server/migration-copy.ts` |
| **Engine** (`node server/main.ts engine`) | the operator | the database (read and write); the paper venues' state; the market-data feeds (public, no credential) | session secrets; any key file | `server/main.ts`; `SECURITY.md` section 2 (3): the API and the engine are separate processes; the API cannot execute |
| **Model** (a client the API calls when asked) | the API | the question and the context QED builds; nothing else | any tool, any credential of the person's, any ability to approve: its output is parsed against a schema and is authority only once the person signs | `SECURITY.md` section 2 (4); `server/ai.ts` |
| **Vault service** (`chain/serve.ts`, the rail) | the operator | its own data folder; the wallet-secret keyring, when sealing is on (`QED_RAIL_SEAL`); development keys of a local chain; the shared chain's RPC; the co-signer's key file, which it opens (unsealing it when sealing is on) only to hand it to the co-signer and to store the keys the co-signer makes (R13) | the engine's database; the person's passkey private key (the passkey signs on the person's device) | `chain/rail/sealed-at-rest.ts`; `chain/rail/keys.ts`; `chain/rail/cosigner-client.ts` |
| **Co-signer** (`chain/rail/cosigner-main.ts`) | the rail, over a private IPC channel | its own signing keys (one per workspace scope and version), received at each start as its key file's bytes on an inherited pipe (file descriptor 4); a key it makes goes back over the IPC channel and the rail stores it (sealed when sealing is on) before the request that needed it is answered; the vendored policy engine | any keyring or key-encryption key, and any key setting: its environment is exactly `PATH`, `HOME`, `NODE_NO_WARNINGS`, `QED_COSIGNER_STATE` and `QED_COSIGNER_VENDOR_ROOT` (not `QED_KEY_DIR`, `QED_KEY_FILE`, `QED_KEK`, `QED_RAIL_SEAL`, nor its key file's path), and its code imports no key-handling module; its `HOME` is an empty folder made for it, not the user's (R13 review fix F3); the rail's other state. In the container: its own user `qedcosign`, no capabilities (below) | **Verified:** `server/least-privilege.test.ts` (the environment `cosignerEnv` builds from a rail environment holding every key setting; the child's imports); `chain/test/cosigner-key-pipe.test.ts` (sealing on, a real child: its environment read from the operating system holds no key setting before and after restarts; it signs; killed, it is started again with the same key; a rotation's key is stored sealed and survives a restart of the rail; the key file never exists in plaintext); `chain/test/cosigner-process.test.ts` (sealing off) |
| **Local chains** (shared; ephemeral per Security Lab run, scenario or economy) | the vault service | development keys and valueless test tokens; listeners on loopback only; no CORS header; an economy's chain has a private socket behind a guarded front that refuses a web page | any real key or value | `chain/rail/chain-socket.ts`; `chain/test/economies.test.ts`; `chain/test/hazards.test.ts` |
| **Backup and key commands** (`scripts/backup.ts` and the rest) | the operator | the backup keyring and the key-encryption key, for as long as the command runs | the database's live connection (a backup reads a consistent copy) | `server/keys.ts`; `docs/ENCRYPTION.md` |
| **The browser** | the person | its own session cookie (HTTP-only) and the CSRF token it was given; the person's passkey stays on the person's device | any server secret, any other person's data | `server/api.ts` (cookie, CSRF); `server/tenant-isolation.test.ts` |

## Secrets

- **Outside the database and the repository.** Keys are in the key folder (`QED_KEY_DIR`, default `~/.qed/keys`, outside the
  repository and the data folder): the key-encryption key and one keyring for each purpose (backup, migration-copy,
  wallet-secret; database reserved). `server/key-separation.test.ts` shows that a keyring of one purpose never opens another's, and
  `server/keys.test.ts` that a key-encryption key inside the database folder is refused (`key_location`).
- **Not in the process environment of the others.** The key-encryption key read from `QED_KEK` is removed from the
  environment once read (`server/key-config.ts`). The co-signer's environment is listed above and holds no database path
  and no key setting. **R13 review fix F3:** removing a variable does not remove it from the environment the kernel recorded
  when the process started (`/proc/<pid>/environ` on Linux, `ps -E` on macOS), which processes of the same user can read. So
  the supervisor and the wallet service's start, given `QED_KEK`, write it to a private file (mode 600 in a folder of mode 700)
  and re-execute themselves without it (`server/kek-handoff.ts`, `process.execve`: the same pid). **Verified** on this computer:
  `server/kek-handoff.test.ts` shows the finding (a process that deletes `QED_KEK` still shows it in `ps -E`) and the fix (after
  the hand-off the same pid no longer shows it; the file has mode 600). In the container the entrypoint does it before any Node
  process starts, as root, and only then execs `tini` as process 1, so not even process 1 keeps it (NOT VERIFIED here).
- **The co-signer holds only its own keys (R13; superseding this document's first version, 24 November 2026, which recorded
  that its environment included `QED_KEY_DIR` and `QED_KEY_FILE` when sealing was on, so that it could reach the
  wallet-secret keyring and with it the master secret).** The vault service, which holds that keyring anyway, opens the
  co-signer's file and passes its bytes over an inherited pipe at every start and restart; the plaintext is never written to
  disk. What remains, as for every process here: the co-signer runs as the same operating-system user, so the key folder
  (by default under `HOME`) is still readable to its process by the operating system; only its code and its environment no
  longer lead there. The vault service, in turn, now handles the co-signer's key bytes in memory, where before it only could:
  it held the keyring that opens them already.
- **Database.** Passwords are stored as hashes; passkeys as public keys; one-time tokens and session identifiers as hashes (`token_hash`, `session_hash`). No raw secret
  column exists (`server/least-privilege.test.ts` checks the schema's column names).
- **Per-workspace keys.** The vault's owner account is the person's passkey account on the chain, and the co-signer's signing key
  is per workspace scope: one workspace's key never signs for another (`chain/test/workspaces.test.ts`).

## R13 review fix F3: the co-signer as its own user in the container (25 November 2026)

What the image does (`Dockerfile`, `scripts/deploy/entrypoint.sh`, `scripts/deploy/supervise.ts`, `chain/rail/cosigner-env.ts`,
`chain/rail/caps.ts`), all NOT VERIFIED on this computer, which has no container runtime; checked on the built image by
`docker exec <container> node scripts/deploy/isolation-check.ts` (exit status non-zero on any failure):

1. `QED_KEK`, when the host gives it, goes to `/run/qed/qed.kek` (mode 600, folder 700, owned by `node`) before any Node process
   starts; the entrypoint then re-executes itself and execs `tini` without it. Checked: no process under process 1 holds the
   name or the key in its `/proc/<pid>/environ`.
2. The image has a second, unprivileged user, `qedcosign`. The co-signer runs as that user through `setpriv` (no supplementary
   groups, no inheritable or ambient capabilities, no new privileges), with its state (its nonces and revocations) in
   `/data/cosigner` (mode 700, that user's; a state file from an earlier image is moved there once). The data folder is mode 711:
   it can be passed through but not listed, and everything in it stays `node`'s (700). The parent still passes the co-signer its
   key over file descriptor 4. Checked: the co-signer's uid and gid differ from the wallet service's and are not 0; its
   capability sets are empty and no-new-privileges is set; as its user, reading the wallet service's `/proc/<pid>/environ`, the
   key folder, the key-encryption key file, the data folder, the wallet service's folder and its token is refused; the running
   co-signer still signs (`/cosigner/self-test`: an EIP-191 signature of one fixed text, which can stand for no certificate, by
   the key the co-signer's own process holds).
3. To start a process as another user, the wallet service needs `CAP_SETUID` and `CAP_SETGID`. The entrypoint therefore starts
   the supervisor as `node` with those two capabilities ambient, the bounding set reduced to those two, and no new privileges.
   The supervisor keeps them for the wallet service only; the API, the engine and every one-off command are started through
   `setpriv` with them cleared, and so are the wallet service's other children (local chains, an economy's agent).

**Residual risk, stated plainly (open):**

- The supervisor and the wallet service hold `CAP_SETUID` and `CAP_SETGID`. A compromised wallet service could switch to any
  user of the container, root included: root without any other capability (the bounding set holds only those two, and no new
  privileges can be gained), but the owner of the root-owned files in the image (the application code under `/app` among them,
  until the next deploy replaces the image). It already holds every key the co-signer holds, and more.
- The API, the engine and the wallet service still run as the one user `node`: the API and the engine can read the wallet
  service's key folder by the operating system's permission, as before; only the co-signer is separated.
- Processes started by `docker exec` or the container's health check get the container's configured environment, `QED_KEK`
  included if the host set it there; they run as root, whose `/proc` entries neither `node` nor `qedcosign` can read. The
  isolation check scans only the processes under process 1.
- A host that starts the container as another user (`RAILWAY_RUN_UID`) gets no second user: the co-signer then runs as that same
  user, as locally. The isolation check fails on such a container (check 1), as it should.
- Locally (macOS, the review build) everything still runs as one user; the co-signer's empty `HOME` and the hand-off of
  `QED_KEK` apply there too.

## Independent review of the fixes (25 November 2026)

A reviewer other than the fixes' author read the merged revision (`1cb35ad`). The final image was then built for
linux/amd64 and `isolation-check.ts` run in it (`docker exec --privileged`, which the environment scan needs to read other
users' `/proc/<pid>/environ`; without it the scan fails closed with "unreadable"): 10 of 10 checks passed, again after a
restart on the same volume.

- **M1, fixed.** The entrypoint ran root commands that follow links in folders the service's user owns (`/run/qed`,
  `/data/cosigner`): a compromised service could have turned the key file into a link and had root write, chmod or chown
  its target at the next start. Now the secrets folder is made anew on every start, the key is written with noclobber into
  that new folder, owners change with `chown -h`, and a link at any place root touches stops the start.
- **M2, fixed.** tsx cached compiled code in `/tmp/tsx-<uid>`, which another process of the same user (the API for the wallet
  service) or a user who made the folder first (for the co-signer) could rewrite. `TSX_DISABLE_CACHE=1` is set for every
  process in the image and in the co-signer's own environment (now six names).
- **M3, partly.** The check now also requires the co-signer to have no supplementary group. Open: the co-signer's user can
  still reach the local chain's TCP listener on loopback, whose `anvil_*` methods are unauthenticated (it is the private
  test chain; nothing else listens), and the self-test's process id is reported by the wallet service itself.
- **Residual, unchanged.** The supervisor and the wallet service hold CAP_SETUID and CAP_SETGID: a compromised wallet
  service could become root inside the container (no other capability, no-new-privs) until the next deploy.
- **Open, for the owner (not in this document's scope):** H1, with a guardian set and every passkey frozen no co-signed
  recovery can finish and nothing can unfreeze one (a permanent hold, which the owner's rule produces); H2, one passkey can
  suspend the household's other passkeys at once, after which the rule's "some passkey not frozen" is met by that passkey
  alone. SECURITY.md, section 8j.

## What is not done (NOT VERIFIED or open)

1. No operating-system isolation between processes in the local build (above): there the co-signer's process could still read
   the key folder as the shared user (R13 removed every way its code and environment pointed there, not the operating system's
   permission). In the container image the co-signer runs as its own user since the R13 review fix F3 (section above): NOT
   VERIFIED until `scripts/deploy/isolation-check.ts` passes on the built image.
2. The engine and the API open the same database file with the same rights; the split is by code (the API cannot execute), not by
   file permission. A read-only database role for the API is possible in SQLite only by opening the file read-only for reads, which
   the API does not do.
3. Per-process audit of the files each process actually opens (strace or an equivalent) has not been run.
4. Tenant isolation inside the vault service is tested by its own suite, not by `tenant-isolation.test.ts`.
