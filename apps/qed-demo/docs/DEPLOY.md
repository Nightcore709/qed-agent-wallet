# Deploying QED on GitHub and Railway: the runbook

Prepared on 24 Nov 2026 (owner mandate R13, section 7) on branch `claude/r13-deploy`, and revised the same day on
`claude/r13-deploy2` (sections 16 to 23: Railway's new configuration form, supply-chain pinning in CI, off-host backups with
retention and drills, runtime hardening, secret rotation, toolchain pins, monitoring, and region and residency).
**Nothing was pushed, provisioned or bought; no Railway or GitHub API was called; no one logged in anywhere.** The only
network reads were public documentation pages (section 23). Every rehearsal below ran on one Mac in
scratch folders on ports 10200 to 10221 and chains 13500 to 13501. Hosted behaviour and remote CI are **not verified**:
section 12 lists what only a real deployment can confirm. This file is the Railway-specific runbook; the production
conversion (TLS, origins, sessions, keys, monitoring, residency) is `docs/PRODUCTION.md`, keys and backups are
`docs/ENCRYPTION.md`, and neither is repeated here.

## 0. What this deploys, and what it is not

- **The demonstration wallet, as on the review build:** live public market prices; **paper** orders, payments, bank,
  loans and escrow; an on-chain wallet on a **local test chain (Anvil, chain 31337) inside the container**, with the
  approved release's contracts and valueless test tokens. Nothing can reach a real bank, broker, exchange account or
  public chain.
- **No real money.** Real-money activity needs licences or licensed partners QED does not have. The readiness page's
  jurisdiction gate (`server/legal.ts`, `GET /api/legal`) keeps every real-money route closed until a licence or a signed
  partner agreement is on record; none is. QED is not production-ready (`REGISTER.md`, `docs/PRODUCTION.md` section 16).
- **Railway is for this demonstration only.** It has no Indian region, so it cannot hold production payment data (RBI
  data localisation; `docs/PRODUCTION.md` section 13). No model is called (`QED_AI_PROVIDER=none`) and no e-mail or text
  provider is configured (`QED_DELIVERY=none`); each needs the owner's separate decision.

## 1. What only the owner does (checklist)

1. Approve the deployment in chat (D-070) and the Railway plan's spending (section 11).
2. Log in: `git push` with your GitHub account; `railway login` in your browser. Nobody else holds these sessions.
3. Choose the public domain **before the first account**: passkeys and every on-chain vault are bound to it
   (`docs/PRODUCTION.md` section 3). The Railway domain (`<name>.up.railway.app`) works; a custom domain can come only
   before anyone signs up.
4. Make the key-encryption key on your computer, escrow it offline, and enter it into Railway yourself (step 2.2). It is
   never in the repository, the image, a log or chat.
5. Sign up as the first owner in a browser with a real passkey at the domain (step 2.7), and keep the recovery codes.
6. Decide backup retention, any off-host copy and the restore-drill schedule (sections 8 and 17). Retention is off until you
   set `QED_BACKUP_RETENTION=on` (it then deletes backups beyond 7 daily, 4 weekly and 3 monthly); off-host copy is off until
   you make a bucket and set `QED_OFFSITE=on`; deleting damaged copies stays yours.
7. **Before 1 Dec 2026**: move Railway's configuration to the new form (section 16), or set the dashboard values (section 16.3).
8. Decide the region and what that means for data you hold (section 22); choose an outside monitor and who is told (section 21).
9. Rotate secrets on the schedule you choose (section 19); put the next date in your calendar.
10. After the first run on GitHub, read the workflow's result and the SBOM artifacts (section 10); merge Dependabot's first
    pull requests on your own terms.

## 2. First deployment, in order

Prerequisites on your computer: git, Node **26.13.1** exactly (`apps/qed-demo/.nvmrc`, the Dockerfile and `package.json`
engines all say so; `.npmrc` has `engine-strict=true`, so `npm ci` refuses another version: section 20), npm 11, and the Railway CLI (`npm i -g @railway/cli`, or Railway's installer). Foundry is not
needed locally; the image builds with Foundry v1.7.1 and solc 0.8.38.

### 2.1 Push to GitHub (owner)

```bash
cd "$(git rev-parse --show-toplevel)"
git checkout main && git merge --ff-only claude/r13-deploy    # or merge it the way you normally integrate
git push origin main                                          # your remote; nothing in this package pushes
```

The workflow `.github/workflows/qed-demo.yml` runs on that push (section 10). Its first run on GitHub (25 Nov 2026) failed on
portability; section 10 says what changed.

### 2.2 The key-encryption key (owner, on your computer)

```bash
cd "$(git rev-parse --show-toplevel)/apps/qed-demo"
mkdir -m 700 ~/qed-railway-kek && QED_KEY_DIR=~/qed-railway-kek npm run keys:init
```

This writes `~/qed-railway-kek/qed.kek` (mode 600), one line `qedkek1:<id>:<key>:<check>`; the keyrings beside it are
not used by the host. Escrow that line offline now (a password manager or printed and locked away): without it no
backup, pre-migration copy or sealed wallet secret can ever be opened. It goes into Railway in step 2.4 with `--stdin`,
so it never appears on a command line. Delete `~/qed-railway-kek` once it is escrowed and set (`rm -rf
~/qed-railway-kek`).

### 2.3 Railway project, service and volume (owner)

```bash
railway login
railway init --name qed-demo
railway add --service qed --repo <github-owner>/<repository>   # the repository you pushed; deploys its default branch
railway service qed                                            # link this folder's CLI to the service
railway volume add --mount-path /data
```

If the CLI refuses `--service` together with `--repo`, run `railway add --repo <github-owner>/<repository>` and rename
the service to `qed` in its Settings. Railway may start a first deploy at once; it fails harmlessly (no variables yet:
the supervisor refuses to start without a public origin and a key).

Service settings (dashboard, Settings): **Root Directory** empty (the repository root: the build needs two files
outside `apps/qed-demo`); **Config file path** `/apps/qed-demo/railway.json` **only if you deploy before 1 Dec 2026**
(Railway stops reading config files that day; section 16 gives the new form and the dashboard fallback, and a
deployment made on or after 1 Dec should use section 16 from the start); **Replicas** 1 (a service with a volume
cannot have more). Region: your decision (section 22).

### 2.4 Variables and secrets (owner)

```bash
railway domain                                  # prints https://<name>.up.railway.app; or: railway domain qed.example.com
D=https://<name>.up.railway.app                 # the origin printed above, exactly, without a trailing slash
railway variable set QED_PUBLIC_ORIGIN=$D QED_EXTRA_HOSTS=healthcheck.railway.app QED_TRUST_PROXY_HOPS=1 \
  RAILWAY_DOCKERFILE_PATH=apps/qed-demo/Dockerfile RAILWAY_DEPLOYMENT_DRAINING_SECONDS=30 RAILWAY_HEALTHCHECK_TIMEOUT_SEC=300 \
  QED_SESSION_IDLE_MINUTES=60 QED_SESSION_MAX_MINUTES=1440 QED_BACKUP_EVERY_MIN=60 QED_STOP_GRACE_MS=15000 \
  --service qed --skip-deploys
railway variable set QED_KEK --stdin --service qed --skip-deploys < ~/qed-railway-kek/qed.kek
```

Every setting, with its meaning and default, is in `apps/qed-demo/.env.example`; the image sets the rest
(`QED_DATA_DIR=/data`, `QED_HOST=0.0.0.0`, `QED_LOG_FORMAT=json`, `QED_AI_PROVIDER=none`, `QED_DELIVERY=none`).
Ask on the Anthropic API (the owner's decision of 25 Nov 2026) has its own variables, production values and spending
limits in section 24, with the one-off model check to run after the deploy.
With a custom domain, `QED_PUBLIC_ORIGIN=https://qed.example.com` and its DNS record as `railway domain` prints it.

### 2.5 Deploy

```bash
railway redeploy --service qed --yes      # builds the Dockerfile from GitHub and starts it (later pushes deploy by themselves)
railway logs --service qed                # one JSON line per event
```

A healthy first start logs, in order: `starting` (with the revision), `keyring made (first start)` twice, the wallet
service's archive step (nothing to archive on a new volume) and sealing step, `started` for wallet, engine and api,
the engine's `running`, the API's `listening`, then `wallet service ready`. The deploy succeeds when Railway's check of
`/api/ready` answers 200 (engine running, database at this build's schema, accepting requests).

### 2.6 Health check

```bash
curl -s $D/api/ready     # {"ready":true,"checks":{"database":true,"schema":true,"engine":true,"accepting":true,"wallet":true}}
curl -s $D/api/live      # {"live":true,...}
curl -sI $D/ | grep -i strict-transport-security    # HSTS on every answer under https
```

`wallet:false` means the on-chain wallet is not up yet (it starts in the background; everything else works) or failed
(the log says why). Railway checks the health path only during a deploy; an outside monitor must watch `/api/ready`
afterwards (section 9).

### 2.7 The first owner account

Open the domain in a browser on a device with a passkey (phone or computer), "Create an account", let the device make
the passkey, save the ten recovery codes, open the paper household. There is no administrator account: every account
is an owner of its own workspace. The local rehearsal signed up through the API with a software authenticator
(`scripts/deploy/smoke.ts`); do not run that script against the public deployment (it leaves an account whose passkey
existed only in the script's memory).

## 3. What runs where

One Railway service, one container, one volume. The image (`apps/qed-demo/Dockerfile`) runs `tini` as process 1, the
entry script (as root only to hand `/data` and `/run/qed` to the `node` user, then no capabilities and no new privileges),
and the supervisor `scripts/deploy/supervise.ts`, which starts three separate processes:

| Process | Command | Listens on | Reachable from |
|---|---|---|---|
| API (and the built interface) | `node server/main.ts api` | `0.0.0.0:$PORT` | the internet, through Railway's edge (TLS ends there) |
| Engine (the one runner of scheduled work) | `node server/main.ts engine` | nothing | nothing |
| Wallet service | `node chain/serve.ts` | `127.0.0.1:5176` | this container only (bearer token file on the volume) |
| its local chain | `anvil` (started by the wallet service) | `127.0.0.1:8546` | this container only |
| co-signer | started by the wallet service | none (a child process) | nothing |

Why one service: the API and the engine share one SQLite file, which needs one machine's file locks, and a Railway
volume attaches to one service; the wallet service answers on loopback only (`server/rail.ts` refuses another address)
and holds the chain's keys; its chain must never be public. A split into services on Railway's private network would
need the wallet service's loopback rule replaced by mutual TLS (`docs/PRODUCTION.md` section 2, "Gap for T2").

Why a Dockerfile, not Railpack or Nixpacks: the build needs Node 26 exactly, Foundry's `anvil` and `forge` at v1.7.1, a
solc 0.8.38 build of the owner-account contract checked against its declared SHA-256, and a non-root runtime with an
init process. A Dockerfile pins and checks each of these and runs the same on any container host; Nixpacks is in
maintenance mode and Railpack is Railway's default builder, which detects the Dockerfile anyway (section 11 sources).

The volume `/data`: `app/qed.db` (the database), `app/migration-copies/` (sealed copies before each migration),
`app/rail.db`, `app/rail.token`, `app/rail/` (the wallet service's records, sealed secrets, chain state), `keys/` (the
backup and migration-copy keyrings, wrapped by the key-encryption key), `backups/` (sealed backups; `wallet-service/`
archives). The key-encryption key itself is written by the supervisor from `QED_KEK` to `/run/qed/qed.kek` (container
filesystem, mode 600, not the volume) and removed from every process's environment.

## 4. Storage, initialisation and migrations

- **First start** (empty volume): the supervisor makes the backup and migration-copy keyrings under `QED_KEK`, the
  wallet service makes and seals its master secret, deploys the test market on a fresh chain, and the engine creates the
  database at the current schema (8).
- **Later starts**: a database at an older schema is migrated once by the engine, after a sealed, read-back-checked
  copy in `app/migration-copies/` (`docs/ENCRYPTION.md` section 4); without the key it refuses and changes nothing. A
  second start finds the current schema and takes no copy (rehearsed: R5).
- **One engine, always**: the engine holds an operating-system lock on `qed.db.engine-lock` and fences itself if another
  engine ever writes its heartbeat (ADR-0013, `docs/PRODUCTION.md` section 8). On Railway a service with a volume cannot
  have replicas and Railway never runs two deployments on one volume, so two engines cannot meet; were the database ever
  shared over a network file system, the fence stops the second one.
- **Scheduled and in-flight work is idempotent**: every run is unique per instruction and occurrence; every action
  carries its economic id to the venue and the ledger, so a restart resumes it rather than repeating it; runs that fell
  due while nothing ran are recorded as missed, never executed late (rehearsed: R3).

## 5. Health, readiness, logs and graceful shutdown

- `GET /api/live`: the process answers. `GET /api/ready`: 200 only with the database answering, at this build's schema,
  the engine's heartbeat under 20 s old and the API not draining; the wallet service is reported, and gates readiness only
  with `QED_READY_REQUIRES_WALLET=1`. Under a public origin both answer check names and booleans only, and
  `/api/health` no longer shows process ids or counts. `healthcheck.railway.app` reaches these three paths and nothing
  else (421). Tests: `server/probes.test.ts`.
- **Logs**: one JSON object per line (`ts`, `level`, `svc`, `event`, fields); every child's line passes through
  `server/log.ts`'s redaction (keys, cookies, tokens, passwords, recovery codes, query strings, 32-byte hex, e-mail
  addresses and payment handles removed; tests: `server/log.test.ts`). The API logs a failed request's method and path,
  never its query string or body.
- **SIGTERM** (a redeploy or stop): the supervisor stops the API (stops accepting, ends live event streams, lets
  requests under way finish), then the engine (no new pass; the step under way finishes; its last heartbeat says
  stopped), then the wallet service; each has `QED_STOP_GRACE_MS` (15 s) before it is killed. Railway waits
  `RAILWAY_DEPLOYMENT_DRAINING_SECONDS` (set to 30; its default is 0) before SIGKILL. Tests: `server/shutdown.test.ts`.
- **A crashed process** is restarted by the supervisor after 1, 2, 4 ... 30 s; six exits in ten minutes stop the
  container (exit 1) and Railway's restart policy restarts it.

## 6. Operating it

From your computer: `railway ssh --service qed`, then inside the container:

```bash
/app/apps/qed-demo/scripts/deploy/ops.sh status          # engine, data sources, prices, downtime
/app/apps/qed-demo/scripts/deploy/ops.sh verify          # every ledger and receipt chain (exit 1 on a break)
/app/apps/qed-demo/scripts/deploy/ops.sh backup          # a sealed backup now (also every QED_BACKUP_EVERY_MIN)
/app/apps/qed-demo/scripts/deploy/ops.sh backup-verify   # every sealed set decrypted and checked
/app/apps/qed-demo/scripts/deploy/ops.sh drill           # restore the newest backup into a scratch folder and verify it
/app/apps/qed-demo/scripts/deploy/ops.sh backups         # list backups and wallet-service archives
/app/apps/qed-demo/scripts/deploy/ops.sh copies          # list the pre-migration copies
/app/apps/qed-demo/scripts/deploy/ops.sh maintenance-on  # stop the services; the site answers 503 (maintenance-off starts them)
```

To keep a backup off Railway, copy the sealed files out (they are useless without the escrowed key):
`railway ssh --service qed` and `tar -C /data -cf - backups | base64` is one way; any copy method works. An off-host
store with object lock is a paid service and the owner's decision (`docs/ENCRYPTION.md` section 7).

**Off-host copy, retention and drills** have their own commands (`offsite-push`, `offsite-list`, `offsite-drill`, `prune`,
`offsite-check`); `ops.sh revoke-sessions` signs everyone out (section 19). The older note on copying by hand stays valid.

**Key rotation** (the key-encryption key): section 19 has the full procedure with the other secrets. (The first version of this
paragraph said to write the new record to a file and pass it to `rewrap --new-key-file`; that is wrong: `--new-key-file`
makes a NEW key at a path that must not exist and never overwrites one. An existing record is passed with `--new-key-env`,
which `ops.sh rewrap` does.)

## 7. Upgrades

Merge and push; Railway builds the new image and replaces the container (stop-first: a service with a volume has a
short downtime on every redeploy). The new engine migrates the database once after a sealed copy. Before a release that
migrates the schema: `ops.sh backup`, and note the time. After it: `curl $D/api/ready`, `ops.sh verify`, `ops.sh copies`
(one new copy).

## 8. Backup, restore and rollback

- **Backups**: sealed (AES-256-GCM under the backup keyring) every `QED_BACKUP_EVERY_MIN` and on demand; the wallet
  service's files are archived, sealed, at every start (it must be stopped to copy them consistently), when changed. They
  live on the same volume: a lost volume loses them, so also enable Railway's volume backups (daily kept 6 days, weekly 27,
  monthly 89; priced as volume storage; docs.railway.com/volumes/backups, read 24 Nov 2026) and turn on the off-host copy
  (section 17). **Retention is automated but off by default**: with `QED_BACKUP_RETENTION=on` the supervisor keeps 7 daily,
  4 weekly and 3 monthly backups and deletes the rest, on the volume and off-host (section 17.2); until you set it nothing
  deletes a backup, so watch the volume's use. A scheduled restore drill is also off by default (`QED_DRILL_EVERY_HOURS`).
- **Restore** a sealed backup over the live database: in the container `ops.sh backups`, pick `<id>.manifest.json`, then
  `railway variable set QED_RESTORE_MANIFEST=/data/backups/<id>.manifest.json QED_RESTORE_CONFIRM=<id> --service qed`
  (redeploys). Before anything starts the supervisor seals the current database into `backups/before-restore-<time>`
  (or, if it is damaged, moves it aside whole into `app/damaged-<time>/` and keeps it), restores, runs `verify`, records
  `app/restored-<id>.json`, then starts the services. Remove both variables afterwards (a later start with them still set
  only logs a warning). Rehearsed: R4.
- **Rollback of code only** (no schema change since): dashboard, Deployments, the last good deployment, Rollback (images
  are kept 72 hours on Hobby, 120 on Pro). Or revert the commit and push.
- **Rollback across a migration**: the previous build refuses a database a newer build migrated and changes nothing
  (rehearsed: R6). Restore the copy sealed before the migration (`ops.sh copies`; its manifest is
  `/data/app/migration-copies/<mc id>.manifest.json`) with `QED_RESTORE_MANIFEST` and `QED_RESTORE_CONFIRM=<mc id>` as
  above, then roll the deployment back. Everything written after that migration is lost: release migrations right after
  a backup, in a quiet hour. Contracts on the test chain are never rolled back.
- **Lost volume**: new volume, the same `QED_KEK`, upload a sealed backup set (with its `keyring.json`) to `/data/backups`,
  restore as above. Without the escrowed key nothing can be restored.

## 9. Monitoring and incidents

(The probes, log drain, alert rules and outside monitor, with their configuration, are section 21; this section is the
first-response table.) Railway checks health only during a deploy and keeps logs 7 days (Hobby) or 30 (Pro). Monitoring therefore needs an
outside monitor (a free tier exists; choosing one is the owner's decision): alert on `/api/ready` not 200 twice a minute
apart, and on a TLS certificate under 14 days. Watch the logs for `"level":"error"`, `exited unexpectedly`, `scheduled
backup failed`, `wallet service did not become ready`, and the engine's `stopped acting` (exit 75).

| Symptom | First steps |
|---|---|
| Deploy fails its health check | `railway logs`: a `configuration refused` or `no key-encryption key` line names the variable; `refused to start` names a migration refusal and its fix |
| `/api/ready` 503 with `engine:false` | `railway logs` for the engine's restarts; `ops.sh status`; the engine resumes in-flight work and records the gap as downtime |
| `schema:false` | another build migrated the database: deploy the newer build again, or restore its pre-migration copy (section 8) |
| `wallet:false` for long | the wallet service's lines say why; the rest of QED works; `railway redeploy --service qed --yes` |
| Suspected compromise | `ops.sh maintenance-on`; rotate `QED_KEK` (section 6); `docs/ENCRYPTION.md` section 3, "Compromise response" |

## 10. Continuous integration

`.github/workflows/qed-demo.yml`. It runs on pushes and pull requests that touch the app, and by hand. Its first run on
GitHub (25 Nov 2026, ubuntu-24.04, the R13 release) failed on portability, not on the product: unit tests that assumed
macOS's case-insensitive volume (`server/path-identity.test.ts`, `server/dev-server-files.test.ts`), the keys in the
owner's `~/.qed/keys` (`server/incidents.test.ts`, `server/session-hardening.test.ts`), or a CPU fast enough to stay inside
the API's thread-time budget (`server/password-change-routes.test.ts`); and forge's own download of solc 0.8.38. The tests
now hold on a case-sensitive volume (the letter-case tests are skipped there by name; the same guards are tested through
links), a fresh home folder (scratch keys) and a slow CPU (that file's budget set above what a minute can hold), and the
compilers come from pinned binaries. Checked in Linux containers on 25 Nov 2026 (the unit suite on linux/arm64, natively: under
amd64 emulation on an Apple-silicon Mac, Node hangs inside SQLite even at the release's revision; the compilers and the hash
check on linux/amd64); **not yet re-run on GitHub, so nothing here is claimed to pass there**.

- **Pinned**: every action is a full 40-character commit SHA with its version in a comment (`actions/checkout` v7.0.1,
  `actions/setup-node` v7.1.0, `actions/upload-artifact` v7.0.2, `foundry-rs/foundry-toolchain` v1.9.2). The SHAs were read on
  24 Nov 2026 from each project's GitHub release page and each commit's page was opened to see that it exists; the
  tag-to-commit mapping came from the release pages and is **not independently verified**: check each with
  `git ls-remote https://github.com/<owner>/<repo> refs/tags/<tag>` before trusting the first run. `.github/dependabot.yml`
  proposes new SHAs, npm and Docker updates weekly; nothing merges itself.
- **Least privilege**: `permissions: {}` for the workflow and `contents: read` per job; no secret anywhere; checkout keeps no
  credentials (`persist-credentials: false`); no `pull_request_target`; the only `${{ }}` expressions placed in a script
  are repository variables passed through `env:`, never interpolated into the shell text. Logs: nothing prints a variable;
  the one input that could carry text (`vars.QED_RELEASE_DIR`) is an existing-directory test only. Concurrency: one run per
  branch or pull request, older ones cancelled, except on `main`.
- **Compilers**: both jobs install solc 0.8.38 and 0.8.26 with `scripts/deploy/install-solc.sh`: the official linux-amd64
  binaries from binaries.soliditylang.org, each checked against the SHA-256 the Dockerfile pins (`server/solc-pins.test.ts`
  holds the two equal), at `~/.svm/<version>/`, where forge looks; every forge step then runs offline (`forge test --offline`,
  `FORGE_OFFLINE=1` for the hash check). forge's own download failed on the runner ("No solc version exists that matches
  =0.8.38"), as it had in the image build. The script refuses to run on anything but Linux x86-64.
- **Job `checks`** (Node from `.nvmrc`, Foundry v1.7.1), in order: `npm ci` (+ the chain's, production dependencies,
  no install scripts) , typecheck, the unit suite, build, **`npm run sbom`** (CycloneDX SBOMs of the app and the chain from the
  lockfiles, and `npm audit` records; uploaded), **`npm run release:check`** only where the release folder exists (the
  repository variable `QED_RELEASE_DIR` names it, for a self-hosted runner; on GitHub's runners it logs a notice that it was
  skipped: the approved release lives on the owner's Mac), **`node scripts/security.ts`**, **the chain's Forge gate**
  (`forge test --offline` in `chain/accounts` with `SOLC_VERSION=0.8.38`), and **the owner-account hash check**
  (`scripts/deploy/build-owner-account.sh` rebuilds the artifact the declared way and stops unless its SHA-256 equals
  `chain/accounts/READY.json`; it runs after `forge test` because a whole-project build can change the artifact's bytes; on this Mac it still matched after `forge test`).
- **Job `browser`**: Chromium, the build, the same hash check, the browser suite; results uploaded.
- **Linting**: no workflow linter (actionlint, yamllint) is installed on this machine and none was added. The three YAML files
  (workflow, uptime probe, Dependabot) were parsed with Ruby's YAML loader (syntax only) and every `uses:` line was checked
  by a script to carry a 40-hex SHA. The expression syntax and the action inputs are **not verified**.
- **Outside probe**: `.github/workflows/qed-uptime.yml` (section 21).

## 11. Expected monthly cost

Railway's published prices on 24 Nov 2026 ([railway.com/pricing](https://railway.com/pricing),
[docs.railway.com/pricing/plans](https://docs.railway.com/pricing/plans), both accessed 24 Nov 2026): Hobby $5 a month
including $5 of usage; Pro $20 a month per workspace including $20 of usage; usage beyond that at $20 per vCPU-month,
$10 per GB of memory a month, $0.15 per GB of volume a month, $0.05 per GB of egress, metered per second; builds are not
charged; volume backups are charged as volume storage for their incremental size. Hobby volumes go to 5 GB.

Measured footprint (R1, this Mac, Node 26.12.0, idle with live prices flowing): 8 processes, 373 to 429 MB resident in
all, 2 to 7% of one core; the volume held 9 MB after the first start and grows with records, hourly backups and the
chain's state.

| Assumption | Usage per month |
|---|---|
| memory 0.45 GB average (Linux may differ: H-10; at 0.9 GB add $4.50) | $4.50 |
| CPU 0.05 vCPU average | $1.00 |
| volume 1 GB, volume backups 1 GB | $0.30 |
| egress 1 GB (pages and API answers for a few reviewers) | $0.05 |
| **total usage** | **about $5.85** |

**Expected bill: about $6 a month on Hobby** (the $5 fee counts towards usage; the difference is charged), **up to
about $11** if Linux memory is double the measurement; **$20 a month on Pro** while usage stays under $20. A domain of
your own costs whatever your registrar charges. No other paid service is needed; an outside monitor and an off-host
backup store are optional and the owner's decision.

## 12. Checks only a real deployment can make

| Id | Check | How |
|---|---|---|
| H-1 | The image builds on Railway's builder: the Foundry image pulls, forge fetches solc 0.8.38 and reproduces the artifact's SHA-256, `anvil --version` runs in the Debian runtime, the build-time `test -f` checks pass (they also prove the root `.dockerignore` let the needed files in). Then pin `node:26.13.1-bookworm-slim` and `ghcr.io/foundry-rs/foundry:v1.7.1` by digest | the build log |
| H-2 | The volume is mounted owned by root and the entry script gives it to `node`; the services run as `node` | `railway ssh`, `ps -o user,pid,args -e` and `ls -ld /data` |
| H-3 | Railway's health check from `healthcheck.railway.app` reaches `/api/ready` and the first deploy passes within 300 s | the deploy's status |
| H-4 | Exactly one proxy hop: `QED_TRUST_PROXY_HOPS=1` gives the client's address | sign in, then `ops.sh status` / the audit rows show your address, not Railway's |
| H-5 | Railway forwards the public `Host`; under https the cookie is `__Host-qed_session` with `Secure`, HSTS is sent, and a passkey works on a real phone and computer at the domain | browser developer tools; step 2.7 |
| H-6 | A redeploy sends SIGTERM and waits the 30 s drain: logs show `stopped` with `abandonedRequests` 0 and `abandonedStep` false; measure the downtime of a redeploy with a volume | `railway logs` during `railway redeploy` |
| H-7 | The market data sources answer from Railway's region (some exchanges refuse some countries' addresses); a refused source is shown as down and its prices are not used | `ops.sh status`, `providers` |
| H-8 | Volume backups are available on the chosen plan, and a restore of one works | dashboard, Backups |
| H-9 | The workflow runs green on GitHub (its actions are already pinned by SHA; check each SHA against its tag, section 10) | the Actions tab |
| H-10 | Memory and CPU on Linux, against section 11's assumptions | the service's Metrics after a day |
| H-11 | Logs in Railway's viewer carry no secret or personal data | search the log for `@`, `qed_session=`, `qedkek1` |
| H-12 | Railway's configuration is in the new form (or the dashboard fallback) before 1 Dec 2026, and a plan shows no change to the volume | section 16; `railway config plan` |
| H-13 | The hardened container runs: read-only root, dropped capabilities, `no-new-privileges`, limits; nothing logs a write error (`EROFS`, `EACCES`); the health check turns healthy; a restart keeps the data | `docker compose -f apps/qed-demo/deploy/hardening/compose.hardened.yml up`, `docker inspect`, logs (section 18) |
| H-14 | The off-host copy: a real bucket accepts the signed requests, `offsite-drill` passes against it, retention deletes only what it should (try with `QED_RETAIN_DAILY=1` on a scratch prefix first), and the provider's key policy is as narrow as section 17 says | `ops.sh offsite-push`, `offsite-drill`, `prune` |
| H-15 | The rail-token rotation of section 19 works as written (the API follows the new token without a restart of its own) | section 19, step by step, on a scratch deployment |
| H-16 | `railway config migrate` output equals the values in `railway.json` (builder, healthcheck, restart policy, draining), and the deployed service takes the new form with the volume untouched | `railway config migrate`, `plan` |
| H-17 | The pinned base images' digests (Node 26.13.1, Foundry v1.7.1) and the SHAs of the actions | section 20 |

## 13. Rehearsal evidence (local, 24 Nov 2026)

On this Mac (macOS 15.4.1, arm64, Node 26.12.0, npm 11.20.0, Foundry 1.7.1), in
`/private/tmp/claude-501/…/scratchpad/r13-deploy/` (scratch; removed afterwards), with the rehearsal's settings:
`QED_PUBLIC_ORIGIN=http://qed.localhost:10200` (the production code path; plain http is accepted for `*.localhost`
only), `QED_HOST=127.0.0.1`, `QED_EXTRA_HOSTS=healthcheck.railway.app`, the wallet service on 10201 with its chain on
13500, `QED_DATA_DIR` a scratch volume, `QED_SECRETS_DIR` a scratch folder, `QED_KEK` a throwaway record made by
`npm run keys:init`, `QED_LOG_FORMAT=json`. Times are wall-clock on a machine shared with other work.

**R1, clean startup from a fresh clone of `e69fd76`** (the final code; later commits change this file only):
`git clone --depth 1 --branch claude/r13-deploy file://<repository> rf` 10 s, no symbolic link and no `node_modules` in
the app; `npm ci --prefer-offline` (93 packages) and `cd chain && npm ci --prefer-offline --omit=dev` (21) 14 s, exit 0;
`npm run build` 8 s, exit 0; `scripts/deploy/build-owner-account.sh` 28 s, `SHA-256 84566df1… matches READY.json`;
`npm run keys:init` into a scratch escrow folder; `node scripts/deploy/supervise.ts` on an empty volume: `/api/ready`
200 from Host `healthcheck.railway.app` 2 s after start, the wallet service ready 4 s after start (`fresh chain
deployed`, its secrets sealed); the same host on `/api/session`: 421. `node scripts/deploy/smoke.ts --base
http://127.0.0.1:10200 --origin http://qed.localhost:10200`: ready (all five checks true), live, signed up with a passkey
(relying party `qed.localhost`, 10 recovery codes), paper household, payee, payment of ₹1,234.00 approved with the passkey,
carried out by the engine and `done` 3.3 s later (`settled`, receipt chain intact). SIGTERM: exit after 0.15 s, API and
engine stopped with nothing abandoned, nothing left listening, no `-wal` or `-shm` left. The supervisor's output: 24
lines, every one JSON; the escrowed key's secret part, any session cookie value and the payee's handle appear 0 times.
The first run of R1 (at `e68117d`) found a defect, fixed in `6700792`: on an empty volume the wallet service's folder
did not exist when its secrets were prepared for sealing, so the first start stopped. R4 found a second, fixed in
`f95d564`: the restore path could not open a damaged database.

**R2, SIGTERM**: supervisor exited 0.27 s after SIGTERM: API stopped (`waitedMs` 7, `abandonedRequests` 0), engine
stopped (`waitedMs` 14, `abandonedStep` false), wallet service stopped; nothing left listening; no `-wal` or `-shm`
left beside `qed.db` or `rail.db`. The next start recorded the 23 s the engine was stopped as downtime (missed runs 0).

**R3, restart recovery** (a paper payment to `slow@paper`, which stays pending 90 s, in flight each time):
- SIGKILL to the engine and the API at 19:25:45: the supervisor logged both `exited unexpectedly; restarting` (signal
  SIGKILL), restarted them 1 s later, `/api/ready` 200 again at 19:25:50. At 19:27:09 the payment was `done`, with 1
  action for its economic id, 1 paper payment (`settled`), 1 receipt for it.
- SIGKILL to the whole process group (a lost container: supervisor, wallet service, chain, co-signer, engine, API) at
  19:27:22; `-wal`/`-shm` files left behind; restart 25 s later: ready in 2 s, `[rail] ready (chain state restored)`, the
  gap recorded as downtime (27 s), and at 19:28:54 the payment `done` once: 1 action, 1 paper payment `settled`, 1
  receipt. Each start archived the stopped wallet service's files under the backup key.

**R4, backup and restore**: `node scripts/backup.ts create` beside the running services: exit 0 in 0.75 s (snapshot 79
ms, seal 28, check 18); `backup:verify`: 3 of 3 sealed sets. `verify`: three owners, ledgers consistent, 1 receipt
each intact. Stopped; 64 bytes zeroed at the start of every page from page 3 (4.2 MB file); `verify` then exit 1
(`database disk image is malformed`). Restart with `QED_RESTORE_MANIFEST` and `QED_RESTORE_CONFIRM`: the damaged file
moved aside into `app/damaged-…/`, the backup restored and checked (`integrity ok; 3 ledgers, 0 breaks; 3 receipts, 0
broken chains`, 44.7 ms), `verify` consistent for all three, ready in 6 s. A further start with the variables still set:
`restore already applied`, nothing restored.

**R5, migration from an older schema**: the previous release `e3c9fa8` (schema 7) made a real database (an owner signed
up with a passkey, a paper payment settled, a receipt). This build started on a copy of it: the engine sealed
`mc-20261124T140520Z-511fb7` (`purpose: migration-copy`, `migration: {from: 7, to: 8}`) and migrated; ready in 1 s; a new
owner and a payment worked on the migrated database; a restart took no second copy (1 in `migration-copies/`); `verify`:
both owners consistent. (The tests make older databases with `server/schema-fixture.ts`; this rehearsal used the older
build itself.)

**R6, rollback**: the previous release `e3c9fa8` on a copy of the migrated database: `verify` exit 1, `Database … has
schema version 8; this build needs 7 and has no migration from 8.` (its own wording, which still suggests `reset`; this
build's refusal names the way back instead, `server/rollback.test.ts`); the copy byte for byte unchanged. The sealed
pre-migration copy restored to a new path (`integrity ok; 1 ledgers, 0 breaks; 1 receipts`, 40.5 ms), and the previous
release opened it: the first owner consistent, receipts intact; the owner who signed up after the migration absent, as
the rollback loses what was written since.

**Tests on this branch**: `server/log.test.ts` (19), `server/probes.test.ts` (7), `server/shutdown.test.ts` (6, two
deliberate mutations each caught: the engine's stop check removed, the API's wait removed), `server/rollback.test.ts`
(2); the full suite and type check: section 14.

## 14. Gates on the final code (`e69fd76`; later commits change this file only)

- `npx tsc --noEmit -p tsconfig.json`: exit 0.
- `npx vitest run --maxWorkers=4`: 130 files, 1,952 tests, all passed (130 s; 1,918 before this package plus its 34).
- R1 to R6 above. The image build, Railway and GitHub Actions: not run (section 12).
- R1 recorded the owner-account artifact's SHA-256 as `84566df1…`; `chain/accounts/READY.json` has since been replaced by the
  passkey-freeze work (R13) and now declares `15654153…`. `build-owner-account.sh` reads the declared value, so the image
  build checks the current one; the hash in R1 is history (rebuilt and matched on 24 Nov 2026, `SOLC_VERSION=0.8.38 forge 1.7.1`).

**Gates on the revision of 24 Nov (`claude/r13-deploy2`)**: section 23 lists them with their counts.

## 15. Not done here (gaps)

- The image was never built (no container runtime on this Mac): H-1. The supervisor, entry script's logic, keys, restore,
  migration and processes were rehearsed directly on the host instead.
- Railway behaviour, GitHub Actions and real devices: section 12. The Railway CLI commands are as Railway documents them
  (docs.railway.com, accessed 24 Nov 2026), not run.
- Backups share the volume until the owner turns on the off-host copy (section 17); the S3 client was tested against a fake
  store on loopback and against AWS's published signing examples, never against a real bucket (H-14). The outside monitor,
  the log drain and the region wait for the owner (sections 21 and 22).
- The hardened container, the health check inside it and the Railway IaC file were never run (H-13, H-16). The workflow ran
  once on GitHub and failed on portability; its fix is not yet re-run there (H-9, section 10).
- The browser suite and the chain's own suite were not re-run for this package (it changes no screen and no chain code).

## 16. Railway configuration after 1 December 2026

**What Railway says** (docs.railway.com, read 24 Nov 2026; section 23): `railway.json` and `railway.toml` ("Config as Code") are
deprecated and "stop being read on 2026-12-01"; "Existing files keep working for legacy services until 2026-12-01". The successor
is Infrastructure as Code in **`.railway/railway.ts`** (TypeScript generally available; Python and Go in beta), applied with the
CLI's `railway config` commands (`init`, `pull`, `plan`, `apply`, `migrate`, `partials`).

### 16.1 Converting, in order (owner; none of this was run)

```bash
cd "$(git rev-parse --show-toplevel)"            # the repository root: the CLI looks for .railway/ from here upward
railway config migrate                                    # preview: shows the .railway/railway.ts it would write; changes nothing
railway config migrate --apply                            # writes .railway/railway.ts from every railway.json in the repository
                                                          # (does not touch Railway, does not clear the Config File path, does not deploy)
npm install railway                                       # the file imports "railway/iac"; the CLI asks for it
railway config migrate cutover                            # clears the service's Config File path in the LINKED environment; no deploy
git rm apps/qed-demo/railway.json && git commit && git push   # only AFTER cutover (with the path still set, a deploy without the file fails)
railway config plan                                       # READ it: no change to the volume; refused while any service still has a Config File path
railway config apply                                      # applies; never accept a plan that deletes, detaches or shrinks the volume
railway config migrate status                             # lists services that still have a Config File path
railway config migrate undo                               # restores the saved path (kept in .railway/.cac-migration.json)
```

`railway config migrate` is the supported converter and the one to trust for the fields the IaC pages do not document (below).
`apps/qed-demo/deploy/railway/railway.ts.example` is a hand-prepared file for the **documented** fields only; it is a starting
point to compare with the migrated file, not a replacement for it. Docs say `railway config pull` shows what Railway holds
today (variables inline only with `--include-variables`, which would write unsealed secrets into the file: never use it here).
`QED_KEK` stays out of any file: `preserve()` keeps the value already set in Railway.

### 16.2 What the new pages do not document (NOT VERIFIED)

The IaC pages (`/infrastructure-as-code`, `/infrastructure-as-code/reference`) document `source`, `build` and `start` (as
commands), `healthcheck`, `healthcheckTimeout`, `preDeploy`, `replicas`, `volumeMounts`, `volume(name, { region, sizeMB })`,
`domains`, `env` and `preserve()`. They do **not** document a Dockerfile builder choice, the restart policy, `drainingSeconds`
or `overlapSeconds`, or per-service CPU and memory limits. So in the example file the Dockerfile path, the draining time and
the health-check timeout travel as service variables (`RAILWAY_DOCKERFILE_PATH`, `RAILWAY_DEPLOYMENT_DRAINING_SECONDS`,
`RAILWAY_HEALTHCHECK_TIMEOUT_SEC`; the last is in Railway's health-check page), and the restart policy is a dashboard setting.
After `migrate`, compare each of `railway.json`'s values with the generated file and with the list below (H-16).

### 16.3 Dashboard fallback (works with or without any file)

Set these in the service (Settings) and variables, then nothing depends on a configuration file:

| Setting | Value | Where |
|---|---|---|
| Builder | Dockerfile; Dockerfile path `apps/qed-demo/Dockerfile` (variable `RAILWAY_DOCKERFILE_PATH` also set, section 2.4) | Settings, Build |
| Root directory | empty (the repository root) | Settings, Source |
| Watch paths | `apps/qed-demo/**`, `docs/shared/RISK_REGISTER.md`, `docs/research/qed-fin-infra-compliance/20261123-jurisdiction-matrix.json`, `.dockerignore` | Settings, Build |
| Healthcheck path / timeout | `/api/ready` / 300 s (variable `RAILWAY_HEALTHCHECK_TIMEOUT_SEC=300`) | Settings, Deploy |
| Restart policy | On failure, 10 retries | Settings, Deploy |
| Draining | 30 s (variable `RAILWAY_DEPLOYMENT_DRAINING_SECONDS=30`) | Variables |
| Overlap | 0 (a volume service stops first) | Settings, Deploy (as `railway.json` had `overlapSeconds: "0"`) |
| Replicas | 1 | Settings, Deploy |
| Volume | mount path `/data` | the service's Volumes |
| Config file path | **empty** | Settings, Config |

`railway.json` stays in the repository until cutover; it is harmless afterwards and is removed in the same commit as the
cutover (above). Dates: today is 24 Nov 2026, so there are seven days. A deployment made after 1 Dec must start from 16.1 or 16.3.

## 17. Backups: off-host copy, retention, restore drills

All three are **off by default**; each is configured by environment variables (`.env.example`) and costs nothing until set.
Code: `server/offsite.ts`, `server/backup-retention.ts`, `scripts/backup-offsite.ts`, the schedule in
`scripts/deploy/supervise.ts`. Tests: `server/offsite.test.ts` (12), `server/backup-retention.test.ts` (7).

### 17.1 Off-host copy (S3-compatible)

`QED_OFFSITE=on` with `QED_OFFSITE_ENDPOINT` (an https origin), `QED_OFFSITE_BUCKET`, `QED_OFFSITE_ACCESS_KEY_ID`,
`QED_OFFSITE_SECRET_ACCESS_KEY` (secrets, Railway variables), and optionally `QED_OFFSITE_REGION` (default `auto`),
`QED_OFFSITE_PREFIX` (default `qed/`), `QED_OFFSITE_PATH_STYLE` (default 1). **Nothing is provisioned**: you make the bucket at a
provider you choose and a key limited to it.

- **Sealed before upload.** The files that leave are the already-sealed backups (`bk-*.qedbak`, AES-256-GCM, with their
  `.manifest.json`), the wallet-service archives (`*.qedseal` and `archive.json`) and the backup keyring (its data keys are
  wrapped by the key-encryption key, which never leaves your escrow). Each `.qedbak` and `.qedseal` has its header parsed before
  upload; a file that does not parse is skipped and named, never sent (tested with a forged file). The store therefore holds
  nothing readable without `QED_KEK`.
- **Transport.** SigV4 over https with Node's `fetch` and `crypto`; no SDK, no dependency. The signer reproduces AWS's two
  published examples ("GET Object" and "GET Bucket (List Objects)") byte for byte. Plain http is accepted only for localhost.
  One request per object, at most 512 MB each; a larger file is skipped and named.
- **When.** After each scheduled backup (`QED_BACKUP_EVERY_MIN`), then retention; also `ops.sh offsite-push` by hand. The
  access key is removed from the API's, engine's and wallet service's environment and given only to `backup-offsite.ts`.
- **Provider setup (yours).** A private bucket with versioning on; if the provider supports object lock, set a retention
  period no longer than your retention below, and set `QED_OFFSITE_PRUNE=off` (deletes then fail until the lock ends, and are
  logged as errors) so that the provider's own lifecycle rule does the pruning. A key allowed to list, put and get under the
  prefix, and to delete only if you want this code to prune. Choose the bucket's region against section 22.
- **Not covered.** No multipart upload; no client-side encryption beyond the sealing above; no replication, no check of the
  provider's durability claims; wallet-service archives are never pruned (they are written only when that service's files change).

### 17.2 Retention: 7 daily, 4 weekly, 3 monthly

`QED_BACKUP_RETENTION=on` (default off). Of each UTC day, ISO week (Monday start) and month, the **newest** backup stands for
that period; the last 7 days, 4 weeks and 3 months that have a backup are kept; a backup kept by any period is kept; the newest
backup is always kept (so today's earlier hourly backups go once a later one exists, and the volume ends with about 7 to 14
backups instead of one per hour). Defaults are `QED_RETAIN_DAILY=7`, `QED_RETAIN_WEEKLY=4`, `QED_RETAIN_MONTHLY=3`;
`QED_RETAIN_HOURLY` (default 0) keeps that many hourly ones too. It looks only at `bk-*` backups (time read from the id); it
never touches migration copies (`app/migration-copies`), `before-restore-*`, `damaged-*`, the wallet-service archives or any key.
It applies to the volume and, with the off-host copy on, to the bucket; `ops.sh prune` runs it by hand. Every deletion removes
the manifest first, so a half-deleted backup never looks complete. Keyring versions that old backups need are not retention's to
delete (`docs/ENCRYPTION.md` section 3 governs revoking a key). The rule is the owner's to change: nothing in this
document is a legal retention period (none was sourced).

### 17.3 Restore drill and its schedule

`ops.sh drill` restores the newest backup into a private scratch folder and runs `node server/main.ts verify` on it (every
ledger and receipt chain); the scratch copy is removed. `ops.sh offsite-drill` does the same with the newest **off-host**
copy, fetched into scratch, proving that the copy opens with this volume's key. **Schedule** (off by default): set
`QED_DRILL_EVERY_HOURS=168` (weekly) and the supervisor runs both, logging `scheduled restore drill passed` or `scheduled
restore drill FAILED` (an error line; also `off-host restore drill FAILED`); section 21 turns those into alerts, including the
absence of a pass for 8 days. Also drill by hand after every key rotation and before every migrating release. A passed drill proves
the sealed file decrypts and the restored database verifies; it does not prove that your off-host key still works, so also
read `ops.sh offsite-list` after rotating that key.

**Whole-volume loss**: new volume, the same `QED_KEK`, `QED_OFFSITE_*` set, then in the container
`node scripts/backup-offsite.ts fetch <backup id> /data/backups` (it also fetches the keyring), then the restore of section 8.

## 18. Runtime hardening

| Control | State | Where |
|---|---|---|
| Non-root services, no capabilities, no new privileges | **Done in the image**: the entry script is root only to hand `/data` to `node`, then `setpriv --inh-caps=-all --no-new-privs` to the supervisor; the API, engine and wallet service run as `node` | `scripts/deploy/entrypoint.sh` |
| Health check | **Added**: `HEALTHCHECK` (30 s, start period 90 s) runs `scripts/deploy/healthcheck.ts`: loopback `GET /api/live` with a Host the API accepts, exit 0 on 2xx; it is liveness, not readiness, so a runtime never restarts the service for a migration. Tests: `server/healthcheck.test.ts` (3). **Railway's docs describe only its own check, at deploy, and do not mention a Dockerfile HEALTHCHECK**: do not rely on it there | `Dockerfile` |
| Read-only root filesystem | **Not possible on Railway as far as its documentation shows** (no setting found, read 24 Nov 2026). **Prepared for hosts that have it**: `deploy/hardening/compose.hardened.yml` sets `read_only: true`, with `/data` (volume), `/run/qed` (tmpfs, the key file) and `/tmp` (tmpfs, drill scratch) as the only writable places. **NOT VERIFIED**: I did not run it; a write outside those three would show as `EROFS` (H-13) | compose file |
| Dropped Linux capabilities | `cap_drop: [ALL]` then `CHOWN, FOWNER, DAC_OVERRIDE, SETUID, SETGID` for the entry script only (`chown`, `chmod`, `setpriv`); the services themselves have none. Strictest form: pre-own the volume for uid 1000, run `user: "1000:1000"` and add nothing back (the entry script then just runs the supervisor). Not verified | compose file |
| No shell in the final image | **Not done; not practical without breaking operations.** `entrypoint.sh` and `ops.sh` are POSIX `sh` scripts that use `setpriv`, `stat`, `chown`; `railway ssh` and `docker exec` need a shell to reach `ops.sh`. A distroless runtime would need both rewritten in Node (setpriv's job done by running as uid 1000 from the start), the volume ownership handled outside, and `ops.sh` replaced by a Node command; that is a day's work and changes how the owner operates the service, so it is left for the owner's decision. What is already absent: a compiler, Foundry's `forge`, dev dependencies and keys (the `anvil` binary is present, because the wallet service runs it) | `Dockerfile` |
| Resource limits | Compose: 1 GB memory, 1 CPU, 256 processes, 4096 files (measured footprint 373 to 429 MB, section 11). **Railway: its pricing page lists plan maximums only (Hobby 48 GB and 48 vCPU, Pro 1 TB and 1,000 vCPU per service); a per-service limit setting was not found in what I read, so none is set. NOT VERIFIED** whether the dashboard offers one: look under the service's Settings; and use the Monitors of section 21 (Pro) for memory and disk thresholds | compose file |
| Log rotation | Compose: `json-file`, 10 MB by 5 files | compose file |
| Stop behaviour | `STOPSIGNAL SIGTERM`; `stop_grace_period: 40s` against `QED_STOP_GRACE_MS` 15 s per service | `Dockerfile`, compose |
| Image provenance | Base images by tag, to be pinned by digest at the first build (H-1, H-17); no `latest`; build from lockfiles with `--ignore-scripts` | `Dockerfile` |

## 19. Secret rotation

Every secret QED holds, how to rotate it, and what is **not** rotated. The proposed schedule (the owner's to change): the
key-encryption key yearly and at once on any suspected exposure or when a person who held it leaves; the off-host key
yearly; sessions and the rail token on suspicion. None of these procedures was rehearsed on a deployment (H-15); the KEK
`rewrap` itself is the tested command of `docs/ENCRYPTION.md` (`server/backup-cli.test.ts`).

1. **Key-encryption key** (`QED_KEK`; wraps the backup, migration-copy and wallet-secret keyrings).
   1. On your computer make a new record (section 2.2, into a fresh folder) and escrow it offline **beside** the old one.
   2. `railway ssh --service qed`, then read the new record into a shell variable without echo or history:
      `stty -echo; IFS= read -r QED_NEW_KEK; stty echo; export QED_NEW_KEK` (paste, Enter).
   3. Rewrap (this changes no data, only the wrapping): `/app/apps/qed-demo/scripts/deploy/ops.sh rewrap` (it calls
      `backup.ts rewrap --new-key-env QED_NEW_KEK`, which re-wraps the backup, migration-copy and wallet-secret keyrings in one
      step or none, and refreshes the keyring copies beside the sealed wallet secrets). The code's own tests cover rewrap with
      a generated key file (`server/backup-cli.test.ts`); the environment form and `ops.sh rewrap` were run only through
      `sh -n`, not on a container.
   4. **Straight away**, from your computer: `railway variable set QED_KEK --stdin --service qed < <new record file>` (redeploys
      with the new key). Between 3 and 4 a restart would find the old record unable to open the rewrapped keyrings and refuse
      to start; the cure is step 4, and the old record, kept escrowed, can rewrap them back.
   5. `ops.sh backup`, `ops.sh drill`, and with the off-host copy on `ops.sh offsite-push` (it re-sends the rewrapped keyring)
      and `ops.sh offsite-drill`.
   6. Keep the old record escrowed until every archive made before step 3 is no longer needed (`docs/ENCRYPTION.md` section 3,
      which also has the compromise response: on suspected exposure also `revoke` the data keys and re-encrypt).
2. **Session secrets.** There is **no server-held session or cookie signing secret** to rotate: a session is a random token whose
   SHA-256 is the only thing stored (`server/auth.ts`, test `server/auth.test.ts`), and each session has its own CSRF token.
   Rotation therefore means ending sessions: `ops.sh revoke-sessions` marks every open session revoked (tested here on a fixture
   database: 2 revoked, then 0), and everyone signs in again with their passkey. Do it after any suspected cookie theft,
   after rotating the KEK, or when you shorten `QED_SESSION_IDLE_MINUTES` or `QED_SESSION_MAX_MINUTES` (a variable change
   needs a redeploy and applies to new sessions). Passkeys are public keys, recovery codes are stored hashed, and the
   reviewer token `QED_ADVISER_TOKEN` (off by default) is changed by setting a new 32-plus-character variable.
3. **Rail token** (the bearer token the API presents to the wallet service on loopback; file `/data/app/rail.token`, mode 600).
   1. `ops.sh maintenance-on` (stops the API, engine and wallet service; the site answers 503).
   2. In the container: `rm /data/app/rail.token` (the wallet service says "delete the file to have a new one created",
      `chain/rail/main.ts`, and makes a new random one when it starts).
   3. `ops.sh maintenance-off`. The API re-reads the file on each call (`server/rail.ts`), so it follows the new token. If
      `/api/ready` shows `wallet:false` afterwards, `railway redeploy --service qed --yes`.
   The token never leaves the container and never reaches a log (`server/log.ts` redacts tokens).
4. **Off-host access key** (`QED_OFFSITE_ACCESS_KEY_ID`, `QED_OFFSITE_SECRET_ACCESS_KEY`): make a second key at the provider,
   set both variables (redeploy), check `ops.sh offsite-list` and `ops.sh offsite-push`, then delete the old key at the provider.
5. **Not rotated here**: the wallet service's master secret and the chain's keys (a local test chain with valueless tokens;
   there is no rotation procedure and none is claimed; the master secret is sealed at rest under the wallet-secret keyring).
   Railway and GitHub sign-in credentials are yours alone; nothing in the repository, image or workflow holds one.

## 20. Toolchain versions

| Tool | Pin | Where | Why |
|---|---|---|---|
| Node | **26.13.1** exactly | `.nvmrc`, `Dockerfile` (`node:26.13.1-bookworm-slim`), `package.json` engines (`"node": "26.13.1"`) and its lockfile | Node's 11 Nov 2026 security release names v26.13.1 as the 26.x fix (nodejs.org/en/blog/vulnerability/november-2026-security-releases, read 24 Nov 2026; 16 issues, the highest High, in HTTP/2, TLS, `undici`/`llhttp` areas). That page does not mention 26.12.0 or say which are fixed earlier. QED serves plain http behind Railway's edge (its https server is used only with `QED_TLS_CERT_FILE`) and uses `fetch` for market data, so how many of the 16 are reachable here was **not assessed**; the pin follows the owner's instruction to take the release |
| Foundry | **v1.7.1** (deliberate) | `Dockerfile` (`ghcr.io/foundry-rs/foundry:v1.7.1`), workflow (`version: v1.7.1`), `build-owner-account.sh` (warns on another version) | `chain/accounts/READY.json` declares the owner-account artifact's SHA-256, built with forge 1.7.1 and solc 0.8.38; a different forge or solc can change the bytes (the AST node ids are in the artifact). `anvil` of the same release runs the wallet service's chain; its flags (`--hardfork osaka`) are release-sensitive |
| solc | 0.8.38 | `SOLC_VERSION=0.8.38` everywhere; never a bare `solc` | same artifact |
| npm | 11 | `engines` | lockfile format |
| tsx (chain) | **4.23.15**, was 4.19.2 | `chain/package.json`, `chain/package-lock.json` | see below |

**`engine-strict=true` in `.npmrc` plus an exact engine means `npm ci` refuses any other Node.** The development Mac has 26.12.0:
`npm ci` there now fails until Node 26.13.1 is installed (`nvm install`; nothing was installed by this work), while running
the already-installed tests and tools is unaffected. CI and the image use 26.13.1.

**tsx and esbuild (GHSA-67mh-4wv8-2f99).** The advisory (github.com/advisories/GHSA-67mh-4wv8-2f99, read 24 Nov 2026): esbuild 0.24.2
and earlier, fixed in 0.25.0, moderate (CVSS 5.3), its development server sends `Access-Control-Allow-Origin: *`; limited to the
`serve` feature. `npm view tsx` shows 4.23.15 as latest, depending on `esbuild ~0.28.0`; the new lockfile resolves esbuild 0.28.2.
It was installed in a **copy** of `chain/` (never the shared `node_modules`), with `--ignore-scripts`: `npm audit` there reported
0 vulnerabilities (and `npm run sbom` on the real lockfile: 0 for the app and 0 for the chain, down from 2 moderate); `tsc
--noEmit -p tsconfig.json`: exit 0; the chain suite (`node --import tsx --test`, 42 files): **155 tests, 149 pass, 2 skipped,
4 fail, none caused by tsx**: two fail identically on the old tsx (`test/contract.test.ts`: README lacks the
`/workspaces/:workspaceId/signers/freeze` example, and PARITY.md's count is stale: documentation left by the passkey-freeze
change, not in this task's remit); `test/resilience.test.ts` "a reorganisation that replaces the block of a done job" failed on the old tsx alone and passed on the new one
(a flaky test); `test/owner-account-wiring.test.ts` "an undeclared or mismatched build is refused" failed only because the copy's
folder was named `chain-trial` (it asserts the path ends in `chain/accounts`) and passes 3 of 3 in place on the old tsx. The
copy was removed. **The suite was not re-run in `chain/` itself with the new tsx**, since that needs `npm ci` there, which the Node
pin blocks on this machine, so that last step is for the first CI run. Earlier records of the two advisories
(`docs/standards/SSDF-SLSA.md` 6.2, `docs/PENTEST-PACKAGE.md`, `docs/SECURITY-REVIEW-R13.md`, `chain/README.md`) are history and stay.

**Upgrading Node**: change `.nvmrc`, `Dockerfile`'s `NODE_IMAGE`, `package.json` engines (and `package-lock.json`'s copy of it),
read the release's security notes, `nvm install`, `npm ci`, typecheck, the whole unit suite, the browser suite, then pin the
image by digest (`docker buildx imagetools inspect node:<ver>-bookworm-slim`, copy the `sha256:` into `ARG NODE_IMAGE=node:<ver>-bookworm-slim@sha256:<digest>`).

**Upgrading Foundry** (never as a side effect of anything else; an owner decision, because it can change the artifact):
1. Read the release notes and advisories for the new version; note changes to `anvil`'s defaults and flags.
2. Install it beside the old one (`foundryup -i v<new>` keeps both under `~/.foundry/versions`); do not replace the pinned one.
3. In a scratch copy run `SOLC_VERSION=0.8.38 forge build --force src/QEDOwnerAccount.sol test/Invariant.t.sol` with the new forge, compare the artifact's SHA-256 with `READY.json`. **If it differs, stop**: the artifact is the owner-approved declaration; a new hash is a contract change that needs the owner's approval, a fresh `READY.json`, and the owner-account tests (`chain/accounts` `forge test`, `test:seeded`), never an edit of the hash to fit.
4. If it matches: `forge test`, the chain suite with the new `anvil` on the PATH, the unit suite.
5. Change the three pins (Dockerfile `FOUNDRY_IMAGE`, workflow `version`, the version case in `build-owner-account.sh`), pin the image by digest, record it here.

**Actions**: Dependabot proposes SHA bumps weekly (section 10). **Base images**: pin by digest at the first image build (H-1, H-17).

## 21. Monitoring: probes, log drain, alert rules, outside monitor

Everything here is the owner's choice; the configuration is ready, nothing is installed or subscribed. The signal list in
machine-readable form is `apps/qed-demo/deploy/monitoring/alert-rules.yml`.

- **Probes** (the API, no secret, answer booleans only under a public origin): `/api/live` (the process answers),
  `/api/ready` (database, schema, engine heartbeat under 20 s, not draining; the wallet is reported, and gates readiness only
  with `QED_READY_REQUIRES_WALLET=1`), `/api/health`. Railway checks `/api/ready` **at deploy only** (docs.railway.com/deployments/healthchecks,
  read 24 Nov 2026: "does not monitor the healthcheck endpoint after the deployment has gone live"). The container's own
  `HEALTHCHECK` (section 18) serves hosts that use it.
- **Outside monitor** (alert on `/api/ready` not 200 twice a minute apart; TLS certificate under 14 days; no HSTS header):
  options, none chosen. (a) **GitHub's scheduled probe**, ready now and free: `.github/workflows/qed-uptime.yml` checks
  readiness, certificate expiry and HSTS every 15 minutes once you set the repository variable `QED_PROBE_URL`; a failing run
  notifies you through GitHub's workflow-failure notices. GitHub's docs (read 24 Nov 2026): the shortest schedule is 5 minutes, runs
  can be late under load, they run only on the default branch, and in a public repository they are disabled after 60 days
  without activity; so it is a second opinion, not an on-call service. (b) **A hosted uptime service** of your choice, pointed at
  `<origin>/api/ready` with the body check `"ready":true`; a free tier may exist at some providers (not researched here:
  NOT VERIFIED, and its terms and location are yours to read). (c) **Self-hosted Uptime Kuma**: Railway's health-check page names an
  Uptime Kuma template for continuous monitoring; it would be a second service on your plan (cost: section 11 rates), and not
  independent if it runs on the same platform.
- **Log drain.** The services write one redacted JSON object per line to standard output (`ts`, `level`, `svc`, `event`).
  Railway keeps logs 7 days (Hobby) or 30 (Pro) and lets you view, filter and export them; its observability page points to a
  "Connect a Third-Party Observability Tool" guide that I did **not** read, so whether Railway can stream logs to an outside
  destination, and how, is NOT VERIFIED. On a Docker host the compose file rotates the `json-file` log and any log driver
  (syslog, fluentd, a vendor agent) can replace it. Before any drain: the redaction tests are `server/log.test.ts`; check H-11
  (search the log for `@`, `qed_session=`, `qedkek1`) first, because a drain is a copy that leaves the platform, and for Indian
  data section 22 applies to it too.
- **Alert rules** (page the owner): `/api/ready` failing twice; `exited unexpectedly`; the engine's `stopped acting`
  (exit 75); `scheduled backup failed`; `scheduled off-host push failed` or `prune failed`; `off-host copy incomplete`;
  `restore drill FAILED`; `configuration refused`; **absence** of `scheduled backup sealed` for 3 hours and of `scheduled restore
  drill passed` for 8 days (needs a monitor that can alert on silence). Ticket-level: any `"level":"error"`; `wallet service
  did not become ready`; certificate under 14 days; volume above 75%.
- **Railway's own** (docs.railway.com/observability, read 24 Nov 2026): Webhooks for platform events (deploy succeeded or failed,
  crashes) to your chat or URL; Monitors with thresholds on CPU, RAM, disk and egress with e-mail, in-app or webhook
  notification, **Pro plan only**.
- **Who is told.** The owner decides; until a person is named the first-response table in section 9 has no one to run it.

## 22. Region and data residency

**Railway has no region in India.** Its regions page (docs.railway.com/reference/regions, read 24 Nov 2026) lists four: US West
(California, `us-west2`), US East (Virginia, `us-east4-eqdc4a`), EU West (Amsterdam, `europe-west4-drams3a`) and Southeast Asia
(Singapore, `asia-southeast1-eqsg3a`), and says more may be added. The RS4 cost refresh (`docs/research/qed-quant-finance/20261124-rs4-cost-table-global-refresh.md`)
read the same four on the same day.

**What it means.**
- This deployment holds **no payment data**: paper orders and payments, valueless test tokens and a public-price feed
  (section 0), and the jurisdiction gate keeps every real-money route closed. The RBI rule that payment-system data be
  stored only in India (`docs/PRODUCTION.md` section 13, graded Verified there on 24 Nov 2026) binds payment system operators and
  reaches QED through partners; it is not engaged by a demonstration with no real payment instruction, and it **would** be
  engaged the day real payment data exists.
- It does hold **personal data of whoever signs up**: account and workspace names, passkey public keys and device labels,
  hashed recovery codes, payee names and handles that people type, audit rows with client addresses, and what they ask
  Ask. Whether storing those abroad is allowed under India's DPDP Act is graded **Hypothesis-S** in `docs/PRODUCTION.md` (the Act
  permits transfers abroad unless the Government restricts a country; sectoral rules prevail; the Rules' dates conflict). This
  document makes no legal claim beyond that grading.
- Backups, the off-host bucket and any log drain are copies in whatever region they sit in, sealed or not (sealed backups
  are unreadable without the key; logs are redacted but are not sealed).
- Market data: some exchanges refuse some countries' addresses; the region decides what answers (H-7).

**Options** (none chosen; the owner's decision, with Q-070's scope):
1. **Railway as it is, for the demonstration, with a stated limit.** Choose Southeast Asia (Singapore) as the nearest region
   to India by distance, **not measured** (NOT VERIFIED latency). Tell every reviewer, on the sign-in screen and in the invitation,
   that the service is a demonstration hosted outside India and that they should enter no real personal or payment detail; keep
   `QED_AI_PROVIDER=none` and `QED_DELIVERY=none`. Keep the off-host bucket in a region you accept on the same grounds.
2. **An Indian host for the same image.** The Dockerfile and `compose.hardened.yml` run anywhere that runs containers. The
   22 Nov cost table (read on 22 Nov, `docs/research/qed-fin-infra-compliance/20261122-cost-quality-table.md`; not re-read today)
   lists AWS Mumbai (`ap-south-1`) and Hyderabad (`ap-south-2`), Azure Central India and E2E Networks. Each needs its own runbook,
   TLS and monitoring, and a persistent volume with a single machine (section 3's reasons for one container); that is
   work, not a switch. Its price is in the RS4 file, with one open conflict on the Mumbai ARM line.
3. **Wait.** No hosted deployment until the partners' data terms and the DPDP commencement dates (Conflict in
   `docs/PRODUCTION.md`) are settled; keep the review build local.
4. **Split by data class**: public marketing or a static demo on any region, nothing with accounts. Not built.

**Not claimed anywhere in QED**: that Railway or any host in the list is MeitY-empanelled or suitable for a regulated
partner (`docs/PRODUCTION.md` leaves it Hypothesis-S).

## 23. Gates and sources for the revision of 24 Nov 2026 (`claude/r13-deploy2`)

**Pages read** (public documentation, one fetch each, 24 Nov 2026; no API called, no account used): docs.railway.com/config-as-code/reference;
/cli/config; /infrastructure-as-code; /infrastructure-as-code/reference; /reference/regions; /deployments/healthchecks; /reference/volumes; /volumes/backups;
/pricing/plans; /observability; github.com release pages and commit pages of `actions/checkout`, `actions/setup-node`,
`actions/upload-artifact`, `foundry-rs/foundry-toolchain`; docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows;
github.com/advisories/GHSA-67mh-4wv8-2f99; nodejs.org/en/blog/vulnerability and its november-2026-security-releases post.
The pages were read through a page summariser, so a quoted field name is as that summary reported it: confirm any value you will
rely on (above all `railway config migrate`'s flags and the IaC field names) against the page itself before the cutover.
Railway's `config-as-code` page also still shows the old files as the way to set the builder; its IaC pages do not yet document that.

**Gates** (run on this Mac, Node 26.12.0, Foundry 1.7.1, no network beyond the pages and the npm registry for the chain install and audits):
- `npx tsc --noEmit -p tsconfig.json`: exit 0 (it caught two `erasableSyntaxOnly` errors in the first `server/offsite.ts`, fixed).
- `npx vitest run --maxWorkers=2` after merging the latest `claude/r11-meridian`: 203 files, 2,533 tests, all passed; exit status captured from the command itself.
- New tests: `server/backup-retention.test.ts` (7), `server/offsite.test.ts` (12: signer against AWS's two published examples, client
  against a loopback fake store with pagination and body-hash checks, push, prune and an end-to-end run of the command including the
  off-host restore drill on a real sealed backup), `server/healthcheck.test.ts` (3).
- `scripts/deploy/supervise.ts` with `QED_OFFSITE=on` and no endpoint: refused before anything starts, with the variable named.
- `ops.sh revoke-sessions` on a fixture database: 2 sessions revoked, then 0. `sh -n` on `ops.sh`; `ops.sh rewrap` itself not run.
- `SOLC_VERSION=0.8.38 forge test --offline` in `chain/accounts` (Foundry 1.7.1): 13 suites, 181 tests passed, 0 failed; then the owner-account hash check: `156541539423c81362f3584f162a4820f7333eff3dab8a07950547db8c084417` equals `READY.json`.
- Never run: the image build, the hardened container, the workflow, the uptime probe, Railway's migrate or plan, a real bucket (H-1, H-9, H-13 to H-17).

## 24. Ask on the Anthropic API: models, spending limits and the check (25 Nov 2026, `claude/r13-askmodels`)

The owner's decision (R13, 25 Nov 2026): production Ask answers through the Anthropic API with the best model the budget
can sustain, "the best genuine AI reasoning experience possible for the FinTechathon judges, not simply the cheapest
model". The code is `server/ask-models.ts` (rule, limits, fallback, records) and `server/model-prices.ts` (prices, cost).
The model proposes only: whichever model answers, its reply goes through the same fixed-code checks
(`server/ask-guard.ts` before any model is asked, then `server/ai.ts`), the passkey approval, the policy, the kernel and
the co-signer. The API key stays in Railway's variables; QED never prints or logs it.

### 24.1 Variables (the production values the operator sets)

```bash
railway variable set QED_AI_PROVIDER=anthropic \
  QED_AI_MODELS=claude-fable-5-2,claude-opus-5-5,claude-sonnet-5-5 \
  QED_AI_BUDGET_USD=12.50 QED_AI_HOURLY_USD=3.00 QED_AI_PERSON_DAILY_USD=2.00 QED_AI_SESSION_USD=1.00 QED_AI_RESERVE_USD=1.00 \
  QED_AI_MAX_OUTPUT_TOKENS=8000 QED_AI_MAX_INPUT_TOKENS=40000 QED_AI_MAX_ATTEMPTS=3 QED_AI_TIMEOUT_MS=180000 \
  --service qed --skip-deploys
```

| Variable | Default | Meaning |
|---|---|---|
| `QED_AI_PROVIDER` | `auto` (the image sets `none`) | `anthropic`: Ask uses the API with the key in `ANTHROPIC_API_KEY` (already a Railway secret; never copied). |
| `QED_AI_MODELS` | `claude-fable-5-2,claude-opus-5-5,claude-sonnet-5-5` | Preference order, best first; the last is the economical model. Every id must be in the price table, or the service refuses to start. |
| `QED_AI_BUDGET_USD` | `12.50` | All Ask may ever spend on this installation, counted from every request recorded in its database. |
| `QED_AI_HOURLY_USD` | `3.00` | Everyone together, in any 60 minutes. |
| `QED_AI_PERSON_DAILY_USD` | `2.00` | One person, in any 24 hours. |
| `QED_AI_SESSION_USD` | `1.00` | One sign-in session. |
| `QED_AI_RESERVE_USD` | `1.00` | The end of the budget kept for the economical model. |
| `QED_AI_MAX_OUTPUT_TOKENS` | `8000` | One request's `max_tokens`, thinking included. |
| `QED_AI_MAX_INPUT_TOKENS` | `40000` | The largest prompt sent, as estimated before the call. |
| `QED_AI_MAX_ATTEMPTS` | `3` | Requests for one question at most, retries and fallbacks included. |
| `QED_AI_TIMEOUT_MS` | `180000` | One request's time limit; all the attempts for one question get twice this. |
| `QED_AI_SERVER_FALLBACK` | unset (off) | `1`: also send the API's own refusal fallback (`"fallbacks": "default"`), reserving what its run could cost. |
| `QED_AI_MODELS_REFRESH_MIN` | `30` | How often `GET /v1/models` (free, no tokens) is read again; it is also read when the API starts. |

The question counts that already bounded Ask stay: `QED_ASK_DAILY` (100 a workspace), `QED_ASK_MONTHLY` (1,000),
`QED_ASK_ALL_HOURLY` (600 for everyone), `QED_ASK_CONCURRENT` (4 requests at once).

### 24.2 The models and their prices (verified 25 Nov 2026)

Source: Anthropic, "Pricing", <https://platform.claude.com/docs/en/about-claude/pricing> (read 25 Nov 2026), and the same
figures in the claude-api reference (model table cached 3 Nov 2026). US$ per million tokens, standard inference.

| Model id | Name | Input | 5-min cache write | 1-hour cache write | Cache read | Output | Effort Ask uses |
|---|---|---|---|---|---|---|---|
| `claude-fable-5-2` | Claude Fable 5.2 | 8 | 10 | 16 | 0.20 | 40 | high (demanding) |
| `claude-opus-5-5` | Claude Opus 5.5 | 4 | 5 | 8 | 0.20 | 20 | high (demanding) |
| `claude-sonnet-5-5` | Claude Sonnet 5.5 | 2 | 2.50 | 4 | 0.10 | 10 | medium (demanding fallback), low (routine) |

Also priced, because the API's refusal fallback can answer with them when `QED_AI_SERVER_FALLBACK=1`: Claude Opus 5 and
Claude Opus 4.8 (5 / 25), Claude Sonnet 5 (2 / 10). A response from a model missing from the table is charged at the
dearest price. Thinking is each model's adaptive default (these three do not let a request turn it off); requests carry
no sampling parameter, no prefill and no forced tool choice, all of which these models refuse. The reply schema is sent as
structured output (`output_config.format`, the JSON schema the SDK derives from `ProposalSchema`).

Which models the key may use is read at run time from `GET /v1/models`, never assumed: a model it does not list is not
asked. Whether this key lists Claude Fable 5.2 is **NOT VERIFIED** until the check below runs. Claude Fable 5.2 also needs
the organisation's 30-day data retention (a zero-retention organisation gets a 400 on every request to it) and has no
structured outputs in an organisation with customer-managed encryption keys (claude-api reference, 25 Nov 2026); either
would show as a rejected request, and Ask would move down to Claude Opus 5.5 on each question, at no cost for the 400.

### 24.3 Which model answers (the rule, as `server/ask-models.ts` states it)

1. Each question is **demanding** or **routine**, from its words alone, with no model call (`classifyTurn`):
   routine is the answer to one of Ask's own structured questions, or a short question or look-up; demanding is anything
   about investing, a plan, a strategy or advice, several steps, several requests in one message, or more than 40 words.
   When in doubt it is demanding.
2. A demanding question goes to the first of `QED_AI_MODELS` that `GET /v1/models` lists and whose most expensive outcome
   fits every limit; a model dearer than the last must also leave `QED_AI_RESERVE_USD` unspent. A routine question goes
   to the last, economical model.
3. A request that fails without an answer (model not found, overloaded, rate-limited, a server error, a timeout, a lost
   connection, or a request that model rejects) is sent again with the same system prompt and message to the next model
   down; at the last model a transient failure is retried on it. At most `QED_AI_MAX_ATTEMPTS` requests, with a pause of
   0.5 s, then 1 s (or the API's `retry-after`) after a transient failure. A request that got an answer is never sent
   again, even a refusal or a reply outside the schema. An authentication or billing error stops at once.

Every request is a row of `ai_attempts` (part (w) of the v8 step): the model asked, the model that answered **from the
response**, outcome, HTTP status, request id, tokens in and out, cost, latency, the structured-output result and any tool
call (none is offered). The question's call (`ai_calls`) keeps the summary. The turn shows "Answered by Claude … in N
seconds · a demanding question · US$…" and any model asked first; `/judge` shows the same with "Why this model" and
"What it cost", and the budget used so far.

### 24.4 What it may cost, and the arithmetic behind the defaults

Before each request QED reserves its most expensive outcome: the estimated prompt at the input price plus the whole
output allowance (8,000 tokens) at the output price. A model whose reservation would cross a limit is passed over for a
cheaper one; when none fits, nothing is asked and Ask says which limit was reached (read-only for the budget). After the
request the reservation is replaced by the cost of the tokens the response reported (`usage.iterations` when present);
a request with no response keeps its reservation as its cost, because it may have been billed. The limits are counted
from the database, so they hold across restarts and redeploys.

The prompt, measured 25 Nov 2026 on the test household (`server/testkit.ts`): system prompt 6,831 bytes, snapshot and
question 12,319 bytes, reply schema 4,802 bytes. QED estimates one token per 2.2 bytes plus 1,500, so a first question
is **12,388** tokens and the seventh turn of a conversation (six earlier turns sent) **14,236**. Real counts should be
lower (JSON runs at about 2.5 to 3 bytes a token): **NOT VERIFIED** until the check below prints both.

| Per request | Claude Fable 5.2 | Claude Opus 5.5 | Claude Sonnet 5.5 |
|---|---|---|---|
| Most it can cost, first question (12,388 in, 8,000 out) | 0.0991 + 0.3200 = **US$0.419** | 0.0496 + 0.1600 = **US$0.210** | 0.0248 + 0.0800 = **US$0.105** |
| Most it can cost, seventh turn (14,236 in) | **US$0.434** | **US$0.217** | **US$0.108** |
| Expected, assumed (9,000 in; out 3,000 / 2,500 / 800) | 0.072 + 0.120 = **US$0.19** | 0.036 + 0.050 = **US$0.09** | 0.018 + 0.008 = **US$0.03** (routine) |

The expected row is an assumption (thinking at high effort, a reply of up to about 1,000 tokens), **NOT VERIFIED**; the
records of the first live questions replace it.

- **Session, US$1.00** (8% of the budget). Claude Fable 5.2 is chosen while the session has spent at most
  1.00 − 0.42 = US$0.58: three or four demanding questions at US$0.19 (0, 0.19, 0.38, 0.57 spent before each; the
  fourth only while the conversation is short, since history raises the worst case to US$0.43). Then Claude Opus 5.5
  while at most US$0.79 (one more), then Claude Sonnet 5.5 while at most US$0.89. One session is therefore three or four
  Fable answers, one or two Opus and one or two Sonnet, about US$0.90: a full demanding conversation, and no more than a
  small share of the budget.
- **Person, US$2.00 in 24 hours**: two such sessions for one judge.
- **Hour, US$3.00 for everyone**: Fable while the hour's spend is at most 3.00 − 0.42 = US$2.58, about 13 to 14 Fable
  answers; three or four judges each having a full demanding conversation in the same hour. Beyond that, later questions
  in the hour step down to Opus, then Sonnet, then wait. The budget cannot be spent in less than 12.50 / 3.00 = about
  4.2 hours.
- **Budget, US$12.50**: about 65 Fable answers at US$0.19, or 140 Opus or 480 Sonnet. **Reserve, US$1.00**: the last
  dollar is kept for the economical model, about 35 routine answers, so Ask does not stop on the first judge to find the
  budget nearly gone.
- **Never overspend.** Every request in flight is reserved at its worst case (at most `QED_ASK_CONCURRENT` = 4 at once),
  and the reservation is checked and written with no await between, so requests arriving together cannot all pass. The
  only way past the budget is an input count above QED's estimate on the requests in flight: even double the estimate on
  four Fable requests is about US$0.40.

**The balance cannot be read from code.** The Anthropic API has no endpoint for an account's credit balance, so QED does
not know what is left in the Console. The owner's balance was about US$18 on 25 Nov 2026 (US$3 plus US$15 added): a budget
of US$12.50 keeps US$5.50 for estimation error, the check below and anything outside QED's records. When the owner adds
credit, raise `QED_AI_BUDGET_USD` by that amount, keeping a margin. **After a restore** from a backup, the spend recorded
since that backup is gone from the database: lower `QED_AI_BUDGET_USD` by what the Console shows was spent since, or the
same money could be spent twice. Prompt caching is not used (a cache write costs 1.25 to 2 times the input price, and
the snapshot changes on every question); it is a possible saving on the system prompt, not taken here.

The API's own refusal fallback is off by default: it can run a model QED did not choose, whose run would have to be
reserved on every request (about 60% more on Claude Fable 5.2's worst case, US$0.68 instead of US$0.42, which leaves
two Fable answers a session instead of three or four), and a refusal is an answer here, recorded and shown as one. With `QED_AI_SERVER_FALLBACK=1` it is sent, its run
is reserved, and the model that answered is still read from the response.

### 24.5 The check (run once, after the deploy, by the operator)

```bash
railway run --service qed -- node apps/qed-demo/scripts/ask-model-check.ts
```

`railway run` gives this one local process the service's variables, so the key reaches nothing else. The script reads
`GET /v1/models`, then makes one minimal structured request to each of `QED_AI_MODELS` that is listed, with QED's own
schema and request builder, effort low and `max_tokens` 2,048. It prints the model asked and the model that answered,
latency, input tokens beside QED's estimate, output tokens, whether the reply parsed, and the cost; never the key or a
header (every line is also cleared of anything shaped like a key). At most about US$0.11 + 0.06 + 0.03; a few cents in
practice. These requests are not in the production database, so they come out of the margin, not the budget. Exit 0
means every listed model answered in the schema.

**Not verified here:** any live request (no key on this machine: every test uses a stand-in API); that Claude Fable 5.2
is listed for this key; the real latency at high effort (the timeout allows 180 s a request); that the token estimate
stays above the real counts; that an HTTP error is never billed (the API rejects 4xx, 429 and 529 before a model runs;
other 5xx, timeouts and lost connections are counted at their reservation in case they were).
