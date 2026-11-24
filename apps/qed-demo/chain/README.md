# QED chain rail

The part of the rebuilt QED wallet that keeps the approved release's on-chain capabilities: the release's
contracts run **unmodified** on a local Anvil chain, driven by the release's own engines and roles, behind a small
adapter that adds what the release lacked (durable records, mandatory idempotency, approvals bound to exact terms,
one recorded clock, state that survives a restart). The wallet's system of record is the backend's database ledger;
this rail is one adapter of it (option C of the baseline, `docs/research/qed-systems-architect/20261118-release-feature-baseline.md` §7.0).

**R7: one shared chain, many workspaces** (`docs/r7/00-ARCHITECTURE-DECISIONS.md` D1, D3, D4). The rail is a host:
one Anvil (the shared chain) with the shared test market, one co-signer service, and any number of **workspaces**,
each created with `POST /workspaces` for a member's passkey. A workspace has its own passkey owner account
(`QEDOwnerAccount`, `chain/accounts/`), its own tINR treasury vault, tUSD reserve vault, execution module and treasury
policy, its own keys (HKDF-SHA256 from this installation's master secret) and its own store. **The service holds no
key that can act as an owner**: owner actions are signed by the member's passkey and checked on chain before the rail
relays them. The Security Lab's attacks and every scenario run on an ephemeral chain of their own; nothing on the
shared chain is ever attacked, reset or moved in time.

**Local only.** Anvil on 127.0.0.1 (chain 31337), valueless test tokens (tINR, tUSD, tEUR, tETH: test tokens on a local
chain, not money). Nothing here calls a public RPC, the public QED URL, Railway, GitHub or a model provider. Not
audited; not for real funds. Which row of the parity register (F-001 to F-086) each part delivers, and exactly what is
not finished, is in `PARITY.md`.

## Start

```bash
cd apps/qed-demo/chain
npm ci --ignore-scripts          # exact pins taken from the release's lockfile; no install script runs
node serve.ts                    # multi-tenant (default)
QED_RAIL_MODE=baseline-parity node serve.ts   # the release's single-owner sandbox, for the baseline parity tests only
```

- HTTP on **127.0.0.1:5176** only; Anvil as a supervised child process, reached by the rail only over its IPC socket
  in a folder only this user may enter (0700, the socket 0600). Anvil always opens a TCP listener as well and checks
  neither Origin nor Host on it, so since R13 (F-14) that listener is put on a port browsers refuse (the Fetch
  standard's "bad ports", which govern fetch, navigation and WebSocket under any host name) and started with
  `--no-cors`: no web page can open it, read it or write to it, by WebSocket or after DNS rebinding (G-C4;
  `rail/chain-socket.ts`; `test/anvil-cors.test.ts`; `scripts/security.ts` R14 from Chrome). What remains: a local
  program that is not a browser, or another account on this computer, can still reach the listener; only a chain
  without TCP, or one in its own network namespace or container, closes that. A scripted economy's chain is the same,
  and its run's port is a guarded front for the release's services (`startChainGuard`: no WebSocket, no request with an
  Origin, Sec-Fetch-Site or Sec-Fetch-Dest header, a loopback Host only, JSON POST only; `test/economies.test.ts`). Before R13 the chain listened on
  127.0.0.1:8546 (`QED_RAIL_ANVIL_PORT`, now used only to stop such a chain left running).
- Bearer token: `apps/qed-demo/data/rail.token`, created with mode 600 on first start, never printed.
- Data: `apps/qed-demo/data/rail.db` (the host: registry, clock events, the host's budget; in baseline-parity mode
  also the one workspace's records) and `apps/qed-demo/data/rail/`: chain state, `master.key` (32 random bytes, mode
  600, the root of every service key), `cosigner.key` (the co-signer process's own keys, mode 600, never read by the
  rail), `workspaces/<id>/workspace.db` and `records/` per workspace. Delete both to start from a fresh chain;
  nothing else resets it. A data folder belongs to one mode: starting it in the other mode is refused.
- `GET /health` answers 503 until Anvil, the contracts, the store and the co-signer answer and the vendored release
  files match their recorded hashes, then 200. A rail whose vendored files were edited refuses to start.
- **The owner-account build** is used only when `chain/accounts/READY.json` says `"status": "ready"` for
  `out/QEDOwnerAccount.sol/QEDOwnerAccount.json` and that file's SHA-256 equals `artifactSha256`; otherwise
  `POST /workspaces` answers `503 owner_account_not_ready`. `QED_RAIL_OWNER_ACCOUNT_BUILD=unreviewed` (tests only)
  uses the current build anyway and every view labels it. Each workspace records the build it was deployed from.
- Settings (all optional; described in `rail/main.ts`): `QED_RAIL_MODE`, `QED_RAIL_OWNER_ACCOUNT_BUILD`,
  `QED_RAIL_PORT`, `QED_RAIL_DATA`, `QED_RAIL_ANVIL_PORT`, `QED_RAIL_ANVIL`, `QED_RAIL_MAX_CLOCK_LEAD_S` (5),
  `QED_RAIL_HEARTBEAT_MS` (2000), `QED_RAIL_GAP_S` (15), `QED_RAIL_COSIGNER`, `QED_RAIL_ZK`, each workspace's budget
  `QED_RAIL_QUOTA_PROPOSALS` (240), `QED_RAIL_QUOTA_OPERATIONS` (240), `QED_RAIL_QUOTA_ECONOMIES` (4),
  `QED_RAIL_QUOTA_WINDOW_S` (3600), the host's budget over all workspaces `QED_RAIL_GLOBAL_QUOTA_PROPOSALS` (2400),
  `_OPERATIONS` (2400), `_ECONOMIES` (16), `_WORKSPACES` (60), each new workspace's opening grant
  `QED_RAIL_FAUCET_VAULT_PAISE` (10000000 = 1,00,000.00 tINR) and `QED_RAIL_FAUCET_OWNER_PAISE` (1000000), its daily
  cap `QED_RAIL_WORKSPACE_DAILY_CAP_PAISE` (1000000 = 10,000.00 tINR), the owner account's delays
  `QED_RAIL_ACCOUNT_DELAY_S` and `QED_RAIL_ACCOUNT_RECOVERY_DELAY_S` (259200 = 72 hours each; at least 60), and
  `QED_RAIL_MAX_EPHEMERAL` (2 ephemeral chains at once), the confirmations a job needs before it is reported done
  `QED_RAIL_CONFIRMATIONS` (2, as the household's books use; 1 to 64) and whether the service mines the empty blocks they
  need on the local chain `QED_RAIL_CONFIRM_MINE` (on; `0`: a job waits for the chain's own next blocks), and the
  operator's caps on earned authority `QED_RAIL_EARNED_WINDOW_S`, `QED_RAIL_EARNED_CAP_PAISE`,
  `QED_RAIL_EARNED_CAP_PER_PAYER_PAISE` (30 days, 1,000.00 and 250.00 tINR), the ceiling of the owner's own (below). A
  budget setting that is not a whole number stops the rail at start; it never switches a limit off.
- Developed and tested on **Node 26.12.0** with Foundry's `anvil` 1.7.1 at `~/.foundry/bin`. The rail's own tests were
  not run on an older Node; it needs at least 22.15 (`node:sqlite` without a flag, `module.registerHooks`).

**Loader.** `serve.ts` is plain erasable TypeScript, so `node serve.ts` works on Node 26 as it is. Its first act is
to register **tsx 4.19.2**, the release's own pinned loader, because the vendored release code imports its
siblings as `./x.js` while the files are `./x.ts`, and uses constructor parameter properties; Node's type stripping
supports neither. On Node 26 tsx prints one deprecation notice (`DEP0205`, `module.register`); it is harmless today
and is the first thing to revisit on a Node upgrade. The rail's own files are erasable TypeScript with explicit
`.ts` imports (`npm run lint:erasable` checks this with Node's own stripper).

## The multi-tenant HTTP contract (R7)

Every route is JSON, needs the bearer token (except `GET /health`), refuses an `Origin` header and a non-loopback
`Host`, and answers errors as `{ "error": { "code", "message", "details"? } }`, as below under "Routes".

**Host routes**

| Method and path | Request | Success | Errors |
|---|---|---|---|
| `GET /health` | none, no token | `200` `Health` with `mode` (`"multi-tenant"` or `"baseline-parity"`) and `workspaces` (count) | `503` with the same body while starting or failed |
| `POST /workspaces` | `{ workspaceId, owner: { x, y } or { signers: [{ x, y }, …], threshold, adminThreshold? }, rpIdHash, origin?, recovery?: [{ x, y }], currencies?: { treasury, reserve, route }, authorization?: { assertions: [...] }, timeLock? }` (P-256 public keys of the members' passkeys, hex; `rpIdHash` = sha256 of the relying-party id; `origin` defaults to `http://localhost:5175`). Money-model S5: `currencies` names the workspace's three test tokens, three different currencies of INR, USD, EUR, GBP, AED, SGD, JPY, BHD (`shared/chain-assets.ts`); absent or `{ INR, USD, EUR }` is the default and needs nothing more. Any other set needs `authorization`: passkey assertions over `assetSetDigest(assetSetDocument(...))` by as many members as the admin threshold, checked before anything is deployed; its tokens and pools are deployed on first use. Valueless test tokens only. `timeLock` (R13, default false): start with both vaults' `withdraw`, `ringFence`, `unpause` and `setGuardian` time-locked; `422 time_lock_unavailable` on a build without it. | `201` `WorkspaceView` (with `currencies` and `routeAsset`); the same body again: `200` with `duplicate: true` (the `workspaceId` is the idempotency key) | `422 invalid_workspace`, `422 invalid_currencies`, `403 currencies_not_signed` (`details.digest` and `details.document`: what to sign), `409 currencies_need_authority_budget` (under `QED_RAIL_AUTHORITY=release`), `409 workspace_exists` (same id, another owner, settings or currency set), `409 baseline_parity_mode`, `429 quota_exceeded` (`details.scope: "global"`, `class: "workspaces"`), `503 owner_account_not_ready` |
| `GET /quota` | none | `200` `QuotaView` of the host's budget over all workspaces (proposals, operations, economies, workspaces) | `503` |
| `GET /cosigner/self-test` (R13 review fix F3) | none | `200 { address, signature, message, isolation, pid }`: the co-signer signs one fixed text (EIP-191, never a certificate: it authorises nothing) with the baseline scope's active key, in its own process (`pid`); the deployed image's isolation check (`scripts/deploy/isolation-check.ts`) recovers the signer | `503` while starting |

**Workspace routes**: every route of the tables under "Routes" below, at `/workspaces/:workspaceId/<path>`, plus:

| Method and path | Request | Success | Errors |
|---|---|---|---|
| `GET /workspaces/:workspaceId` | none | `200` `WorkspaceView`: `status` (`awaiting-acceptance`, `ready`), `ownerKind`, `ownerCustody`, `ownerAccount`, `ownerAccountBuild`, `signers`, `threshold`, `guards`, `asset` (tINR, 2 decimals), `reserveAsset` (tUSD), `grant`, `contracts`, `keys` | `404 unknown_workspace` |
| `GET /workspaces/:workspaceId/scheduled` | none | `200 { scheduled: ScheduledChange[] }` newest first: `changeId`, `kind`, `summary`, `status` (`pending`, `applied`, `cancelled`), `calls`, `readyAt`, `readyTime`, `ready` | `404 unknown_workspace` |
| `POST /workspaces/:workspaceId/scheduled/:changeId/apply` | `{}` and `Idempotency-Key`. No approval: the owner account lets anyone apply a change once its delay has passed | `202` `Accepted`; the job's outcome is `executed`, `refused` (not ready yet; nothing sent) or `no-action` (already applied or cancelled) | `404 unknown_change`, `422 invalid_params`, `400 idempotency_key_required`, `429 busy`, `429 quota_exceeded` |

An unknown workspace answers `404 unknown_workspace`, and only after the token was checked. Every proposal, job,
receipt, decision record, submission key and scheduled change is looked up in the named workspace only: an
identifier of another workspace answers 404 (`unknown_proposal`, `unknown_job`, `unknown_receipt`,
`unknown_submission`, `unknown_change`) or an empty list. `GET /workspaces/:workspaceId/receipts/:hash` answers only
for a transaction that workspace recorded, even though the shared chain holds every workspace's transactions. A
workspace's budget (`GET /workspaces/:workspaceId/quota`, with the host's under `global`) and the host's must both
have room.

**A workspace's life**

1. `POST /workspaces` deploys and configures the vault set while the workspace's deployer key is its temporary owner
   and it holds nothing (agent, co-signer, guardian, daily cap, the five venues), deploys the owner account with the
   guard list `chain/accounts` builds for those addresses (`releaseGuards`), and offers it ownership of both vaults.
   `status: "awaiting-acceptance"`; the vaults hold nothing.
2. The owner's first approval is `provision`: one `execute` of `acceptOwnership` on both vaults, signed by the
   passkey. Only after it does the opening grant of test tINR arrive (`grant` in the view; job step `grant`). From
   then on the deployer key can do nothing on any of the contracts.
3. Then a `mandate` (signed by the passkey through ERC-1271; the vault checks it the same way), and every other
   proposal kind of the tables below, in tINR (2 decimals: amounts like `"840"` or `"250.75"`).

**What the passkey signs.** In a passkey workspace every proposal whose terms need the owner carries `terms.toSign`
(covered by `termsHash`): `kind: "execute"` (the account's EIP-712 digest of `execute(calls, nonce, deadline)`, for
owner transactions), `kind: "erc1271"` with `purpose: "mandate"` or `"message"` (the account's replay-safe hash of
the vault's mandate digest, or of an EIP-191 text such as a conversion, payment or policy instruction), or
`kind: "cancel"`. Each item's `digest` is the WebAuthn challenge (32 bytes; base64url in `clientDataJSON`), signed
with user verification. The approval then has a sixth field:

```text
approval = { approvalId, docHash, termsHash, confirmedAt, method: "passkey",
             signatures: [ { assertions: [ { publicKey: { x, y }, authenticatorData, clientDataJSON, signature } ] } ] }
             one entry per item of terms.toSign, in order, each with at least `threshold` members' assertions;
             authenticatorData and signature (DER, as browsers return it, or 64-byte r||s) are hex, clientDataJSON the exact text
```

`POST /workspaces/:workspaceId/proposals/:id/execute` checks every signature **on chain before anything is stored**:
a simulated `execute` for an `execute` item, `isValidSignature` for an `erc1271` item. A refusal stores nothing (the
`Idempotency-Key` stays free) and is recorded as an `approval-refused` decision: `422 approval_signature_missing`,
`422 approval_signature_malformed` (not a `webauthn.get` assertion, bad hex or DER), `409 approval_signature_mismatch`
(made for another challenge), `409 approval_signature_invalid` (the account refused it: not a member, another
origin or relying party, no user verification, a tampered signature; `details.error` names the account's error),
`409 approval_signature_expired`, `409 proposal_stale`. The rail then relays the transaction with the workspace's
relayer key, which is not a signer, and pays its gas. In the baseline-parity workspace the approval keeps its five
fields and the release's development owner signs, as before.

**One signature slot at a time.** An `execute` item is bound to the account's current nonce. Two owner actions of
one workspace prepared before either ran are signed for the same nonce: the first one to run uses it, and the
second is refused before anything is sent (`proposal_stale`, or the job fails with it). Prepare the next owner action
after the previous one finished.

**Scheduled changes.** The owner account refuses to run its guarded calls through `execute` (`GuardedCall`, even with
every member signing): the vaults' `transferOwnership`, `setAgent`, `setCosigner`, `setDailyCap`; the execution
module's `setVenues` and `setOperator`; the policy contract's `setPolicy` and `setAgent`. In a passkey workspace the
rail puts them into one `scheduleCalls` of the same `execute` (`toSign[].schedule` lists them; the admin threshold
applies). Immediate calls in the same batch (for example `QEDTreasuryPolicy.revoke`) run at once. The job's outcome is
`scheduled` with `evidence { changeId, readyAt }`; nothing changed yet. This applies to `rotate-key` for `operator` and
`cosigner` (the guardian's setter is immediate), `venues`, `policy` with contract enforcement (the policy takes
effect when applied) and the operator restore of `policy-revoke`.
- **list**: `GET /workspaces/:workspaceId/scheduled`;
- **cancel**: until `readyAt`, any one member: `POST /workspaces/:workspaceId/proposals { kind: "cancel-change",
  params: { changeId } }`, whose `toSign` is one `cancel` item, then execute it with one assertion;
- **apply**: from `readyAt`, anyone: `POST /workspaces/:workspaceId/scheduled/:changeId/apply`; the job runs
  `applyCalls` and then what the change means on the rail (a rotated key is used from then on; a policy registers with
  the co-signer).

Real output of this service (multi-tenant, `QED_RAIL_ACCOUNT_DELAY_S=60`; long values shortened with `…`):

```text
POST /workspaces
> {"workspaceId":"alice-home","owner":{"x":"0x0d26…","y":"0x3a99…"},"rpIdHash":"0x4996…"}
201 {"id":"alice-home","status":"awaiting-acceptance","guards":[{"target":"0x2155B5…","selector":"0xf2fde38b","reason":"Moves
     every owner power over the vault, …"}, …11 more],"ownerKind":"passkey-account","ownerCustody":"passkey owner account
     (QEDOwnerAccount): its signers are the members' passkeys; the service holds no key that can satisfy it and only relays",
     "ownerAccount":"0xa875f4…","ownerAccountBuild":{"sha256":"84566df1…","solc":"0.8.38+commit.1835d247","declaredReady":true,
     "label":"declared ready by chain/accounts/READY.json"},"signers":[…],"threshold":1,"asset":{"symbol":"tINR","decimals":2, …},
     "reserveAsset":{"symbol":"tUSD","decimals":6, …},"grant":null, "contracts":{ …},"keys":{"agent":"0x…","guardian":"0x…",
     "relayer":"0x…","derivation":"HKDF-SHA256 from this installation's master secret (mode 600); none of them is a signer of the
     owner account"}}

POST /workspaces/alice-home/proposals
> {"kind":"provision","params":{}}
201 {"id":"511626c2-…","kind":"provision","termsHash":"sha256:26d073d3…","terms":{ …,"toSign":[{"kind":"execute","account":
     "0xa875f4…","chainId":31337,"nonce":"0","deadline":"1795330341","calls":[{"action":"QEDVault (treasury).acceptOwnership",
     "data":"0x79ba5097","target":"0x2155B5…","value":"0"},{"action":"QEDVault (dollar reserve).acceptOwnership", …}],
     "digest":"0x44d58c…","threshold":1,"note":"The passkey signs this EIP-712 digest of QEDOwnerAccount.execute(calls, nonce,
     deadline): exactly these calls, once, before the deadline. The rail relays it and pays gas."}]}, "summary":"Accept ownership
     of this workspace's vault set, configured as shown: QEDExecution is the treasury vault's agent, 5 venues are named, the
     daily cap is 10,000.00 tINR. Only after this acceptance does the opening grant of test tINR arrive.", …}

POST /workspaces/alice-home/proposals/511626c2-…/execute        Idempotency-Key: capture-key-0001
> {"approval":{"approvalId":"ap-5c22…","docHash":"sha256:eeee…","termsHash":"sha256:26d073d3…","confirmedAt":"…","method":
   "passkey","signatures":[{"assertions":[{"publicKey":{"x":"0x0d26…","y":"0x3a99…"},"authenticatorData":"0x4996…",
   "clientDataJSON":"{\"type\":\"webauthn.get\",\"challenge\":\"RNWMwPX-eFZv6Ipc_kPd9KSUpM-11_UPX-WT4G5KygE\",\"origin\":
   \"http://localhost:5175\",\"crossOrigin\":false}","signature":"0x3045…"}]}]}}
202 {"jobId":"bf4920f8-…","kind":"provision","status":"accepted","duplicate":false}
    Location: /workspaces/alice-home/jobs/bf4920f8-…; the job's steps owner, receipt, grant; "result":{"outcome":"executed",
    "summary":"The owner account accepted ownership of the treasury and reserve vaults; the opening grant of 100,000.00 test tINR
    arrived in the vault. No mandate is signed yet.", …,"evidence":{"grant":{"vault":"10000000","ownerAccount":"1000000",
    "token":"tINR","txs":["0xd65e92…","0x44b243…"]}}}
    the same proposal type signed by a passkey that is not a member:
409 {"error":{"code":"approval_signature_invalid","message":"The owner account refused the passkey signature:
     NotAMember(0x5dc63c…). Nothing was sent.","details":{"error":"NotAMember","args":["0x5dc63c…"]}}}

POST /workspaces/alice-home/proposals
> {"kind":"rotate-key","params":{"role":"operator"}}
201 { …,"terms":{ …,"toSign":[{"kind":"execute", …,"calls":[{"action":"QEDOwnerAccount.scheduleCalls(QEDExecution.setOperator,
     QEDVault (dollar reserve).setAgent)","target":"0xa875f4…", …}],"schedule":{"actions":[0,1],"calls":[{"action":
     "QEDExecution.setOperator", …},{"action":"QEDVault (dollar reserve).setAgent", …}],"delaySeconds":"60"}, …}]}}
    executed with the passkey: "result":{"outcome":"scheduled","summary":"The operator key rotation to 0x19978ebd… is approved;
    the old key keeps working until it is applied. Scheduled: it takes effect from 2026-11-22T06:33:23.000Z, after the owner
    account's delay; any member can cancel it until then.","evidence":{"changeId":"0xd76e2c…","readyAt":1795329203}}

GET /workspaces/alice-home/scheduled
200 {"scheduled":[{"changeId":"0xd76e2c…","kind":"rotate-key","summary":"Rotate the operator key to 0x19978ebd…","status":"pending",
     "calls":[ …two… ],"readyAt":1795329203,"readyTime":"2026-11-22T06:33:23.000Z","ready":false,"proposalId":"05ca324c-…",
     "jobId":"599d0a8a-…","appliedJobId":null,"cancelledJobId":null,"createdAt":"…"}]}

POST /workspaces/alice-home/proposals
> {"kind":"cancel-change","params":{"changeId":"0xd76e2c…"}}
201 { …,"terms":{ …,"toSign":[{"kind":"cancel","account":"0xa875f4…","chainId":31337,"changeId":"0xd76e2c…","digest":"0x969983…",
     "threshold":1,"note":"One member's passkey signs the account's cancel digest for this change; the account then drops it
     (QEDOwnerAccount.cancel)."}]}}

POST /workspaces/alice-home/scheduled/0xd76e2c…/apply        Idempotency-Key: capture-key-0004
> {}
202 {"jobId":"8670584c-…","kind":"apply-change","status":"accepted","duplicate":false}
    before readyAt: "result":{"outcome":"refused","summary":"This change can be applied from 2026-11-22T06:33:23.000Z, after the
    owner account's delay; not yet. Nothing was sent."}

GET /workspaces/nobody-here/state
404 {"error":{"code":"unknown_workspace","message":"Unknown workspace."}}

GET /cosigner/self-test
200 {"address":"0x7a1c…","signature":"0x…","message":"QED co-signer self-test: this signature authorises nothing.",
     "isolation":"separate-process","pid":48211}

GET /quota
200 {"windowSeconds":3600,"classes":[{"class":"proposals","counts":"proposals prepared","limit":2400,"used":4,"remaining":2396,
     "nextFreeAt":null},{"class":"operations", …},{"class":"economies", …},{"class":"workspaces","counts":"workspaces created",
     "limit":60,"used":1,"remaining":59,"nextFreeAt":null}]}

GET /workspaces/alice-home
200 {"id":"alice-home","status":"ready", …the WorkspaceView of POST /workspaces, with "grant":{"vault":"10000000",
     "ownerAccount":"1000000","token":"tINR","txs":["0xd65e92…","0x44b243…"]}}
```

**Amounts in a workspace** are raw units of its own assets: tINR has 2 decimals (`"10000000"` is 1,00,000.00 tINR,
1 tINR counted as ₹1 and always labelled a test token), tUSD 6. Inputs are human decimals with at most the asset's
decimals (`"250.75"`). The co-signer (`rail/cosigner-engine.ts`, the release's engine with owner signatures checked as
the vault checks them and amounts in the vault asset's units; decision D-A of the R7 orchestrator, recorded in
`docs/r7/00-ARCHITECTURE-DECISIONS.md`) keeps the release's rules in those
units, a reserve buffer of 5 tINR among them, with one exception: its check C12 is the authority budget below (R7
decision D7), not the release's earned allowance. With `QED_RAIL_AUTHORITY=release` C12 is the release's rule again
in tINR units (10 tINR plus half of verified escrow revenue, every certified outflow counted, conversions included),
as it was before D7 was built: after a conversion of more than 10 tINR, payments are then refused until escrow
revenue arrives. The baseline-parity workspace always keeps the release's engine and its C12.

**The authority budget (R7 decision D7, `docs/r7/00-ARCHITECTURE-DECISIONS.md` D7; the rule as corrected in
`experiments/r7/S1-science/D7-authority-budget.md`, sections 2 and 8).** C12 asks whether what an action takes out of
the workspace's control, at reference value, fits in what is available: the owner's grants plus what the workspace
earned, less what has left, less promises not yet paid, less certificates not yet used.

- *The rule* (`rail/authority.ts`) is the reference `d7/budget.py` ported event for event, in exact integers and
  fractions, debits rounded up and credits down; it answers the reference's 400 cross-implementation sequences exactly
  (`test/fixtures/d7_fixtures.json`, regenerated with the quant environment and byte-identical to the experiment's).
- *The chain's history* (`rail/authority-ledger.ts`) is replayed into it at every check, from the vault's, its
  execution module's and the shared escrow's own events: a payment to anyone outside the workspace consumes its
  amount; a payment to the workspace's own vaults or owner account consumes nothing; a conversion consumes only its
  realised cost against the reference, ⌈max(0, spent − out · lo)⌉ from its `BestExecution` event; the agent's forward
  payment is a hold (it uses availability, and budget once it is paid; released, it comes back); the owner's own
  ring-fence, withdrawal and deposit count nothing; an escrow job settled to the workspace adds half its price only
  when its client is outside the principal set, it was paid in tINR, and the settlement has two confirmations.
- *Control C* is the treasury vault, the reserve vault and the owner account; *principal P* is C, the execution module
  and policy contract, every key the service holds for the workspace (deployer, relayer, agent and guardian keys), and
  the same for every workspace that shares a passkey signer with it. The agent key is in P and never in C. A member's
  address the rail has never seen cannot be told apart from an outside client (the spec's A-ID): the budget says so
  beside its figures.
- *Figures*: B0 = 10 tINR (D-A's base, kept), rate ½ (the release's half of revenue), k = 2 confirmations. Every
  figure is reported apart: `granted` (B0 plus owner grants) is never mixed with `earned`.
- *Admission*: a payment or a forward payment needs its whole amount available; a conversion needs its worst case,
  the order's floor (the co-signer's own quote less 1%) valued at the reference band's low end (measured on a fresh
  test chain: 1.56 tINR for 100 tINR, 16.24 tINR for 1,000 tINR); after it executes, its realised cost is what stays
  used (measured: 0.06 tINR for 10 tINR). A certificate the co-signer signed
  and the chain has not used reserves its worst case until it is used, expires (2 hours for a payment, 4 for a
  conversion) or is voided by the vault's epoch, and the co-signer admits one certification of a workspace at a time,
  so two certificates cannot spend the same room. C12 keeps its id and
  its place as a payment's eighth check; a conversion gains it as its last check, because its worst case needs the
  co-signer's quote and floor. Owner grants and outstanding reservations are kept in the co-signer's durable state.
- *The reference band* of tUSD is **fixed in configuration**: the test market's genesis rate (the deep pool of
  `INR_VENUES`, 84 tINR per tUSD) ± 0.5% (`QED_RAIL_AUTHORITY_BAND_BPS`, default 50). The local chain has no price
  source the agent cannot move: every price on it is a CPMM pool's, and the agent's own conversions, other workspaces'
  and anyone holding test tokens (TestUSD has a public faucet) move the pools, so a band read from them could be pushed
  by exactly the coalition D7 guards against, with no bound the spec's T3ε covers. Instead, a conversion is admitted
  only while the venues' depth-weighted mid (the release's T2 figure) lies inside the band widened by
  `QED_RAIL_AUTHORITY_DIVERGENCE_BPS` (default 0): taking that mid as the truth, A-VAL then holds at every admitted
  conversion and T3ε's error is at most the divergence. What it does not do is follow the market: the shared pools
  drift one way with use (workspaces only convert tINR into tUSD; from the genesis reserves, about 23,000 tINR of net
  conversions through the direct venues move their mid out of a fresh chain's band: an estimate, not a measurement),
  and from then on every workspace's conversions are refused until the reference is re-centred.
- *Grants*: the `grant` proposal (`{ amount }`) has the owner's passkey sign an exact text for the owner account
  (ERC-1271); the co-signer checks it as the vault checks owner signatures and keeps it. No money moves.
- *Caps on earned authority* (decision D-K1b, R13): the `earned-caps` proposal (`{ perWindow, perPayer }`, in the
  vault's asset) has the owner's passkey sign the two caps K1 applies (`earnedCapsMessage`: the operator's window, at
  most `perWindow` counted as earned in it, at most `perPayer` from any one payer), checked and kept by the co-signer as a
  grant is. The operator's caps are the ceiling: more is refused (`422 above_ceiling`). A cap lower than the one in force
  applies at once and drops a raise still waiting for it; a higher one waits the owner account's delay
  (`QED_RAIL_ACCOUNT_DELAY_S`, 72 hours by default) before it counts (outcome `scheduled`). The budget's `earnedLimit` is
  the lower of the two; `earnedCaps` in the preview's `authority` shows the ceiling, the owner's caps and any raise
  waiting. No money moves.
- *The preview* `GET /workspaces/:workspaceId/payments/limits` carries `authority`, the co-signer's own figures and one
  sentence adding them up; its `earned { limit, used, remaining }` keeps its shape (limit = granted + earned,
  remaining = what is available).

What D7 changes, and what it does not: payments and conversions coexist (after a conversion of 10 tINR the treasury
can still pay), self-dealt escrow and round trips cannot raise the budget, and the owner can raise it by passkey.
Everything else the co-signer checks (C1 to C11, T1 to T3, P0 to P3), the mandate's limits and the vault's own caps are
unchanged. The budget is not a bound on losses from price moves on holdings, and "earned" means paid for by a client
the rail does not know to be the workspace's own, not that the work was good. It is small on purpose and finite:
without grants or earnings a workspace can pay about 10 tINR over its whole life, or convert of the order of a
thousand tINR (an estimate from the measured realised cost of 0.6%, not a measurement), and a standing policy's
tranches are refused once their worst case no longer fits.

**Routes in the tables below** are the routes of one workspace. Their examples were captured on the baseline-parity
workspace (`/workspaces/baseline/…`, tUSD and tEUR, the release's development owner, five-field approvals); a passkey
workspace answers in the same shape in tINR and tUSD, and its approvals carry `signatures`.

## Signers, recovery and earning (RISK-053, R7-054; 22 Nov 2026)

Both work through contracts that already existed, unmodified: the owner account's own signer, threshold and recovery
functions (`chain/accounts`), and the release's ProofEscrow with its MinVarianceVerifier, shared by every workspace.
No Solidity changed. Proposal kinds go through `POST /workspaces/:workspaceId/proposals` and
`…/proposals/:id/execute` exactly as the others (the passkeys sign `terms.toSign`, checked on chain first).

**Signers** (rail/signers.ts):

| Kind | Params | What the account does | Approvals |
|---|---|---|---|
| `add-signer` | `{ x, y, role: "member" \| "recovery" }` | `addSigner` at once (the contract makes additions immediate: they lower no threshold, and `adminThreshold ≥ threshold`, so fewer members than the threshold can never add one and then reach it). Outcome `executed`. | admin threshold |
| `remove-signers` | `{ signerIds: [0x…] }` | `removeSigners`: scheduled behind the delay (outcome `scheduled`, `evidence { changeId, readyAt }`); any member it does not remove can cancel it (`cancel-change`; the removed passkey gets `409 cannot_cancel_own_removal`); applied by anyone after the delay (`POST …/scheduled/:changeId/apply`, which calls `applyChange`). Refused before anything is prepared, and by the account itself, if fewer members than the admin threshold would remain: `409 would_break_quorum`. | admin threshold |
| `set-thresholds` | `{ threshold, adminThreshold? }` | `setThresholds`: raising either is immediate (`executed`); lowering either is scheduled like a removal and re-checked when applied (`409 change_stale` if they changed meanwhile). `422 invalid_thresholds` unless 1 ≤ threshold ≤ adminThreshold ≤ members. | admin threshold |
| `set-guardian` (R13) | `{ x, y }` (a passkey public key) or `{ remove: true }` | `setGuardian`: always `scheduled` behind the delay; any member can cancel; applied only if the guardian is still the one it replaces. While one is set, `POST …/recoveries` needs its `cosign`, and a frozen member cannot cancel a co-signed recovery. `409 signer_exists` (a signer's key), `409 no_guardian`, `409 guardian_change_pending`, `409 owner_options_unavailable` (an account built before R13's owner options) | admin threshold |
| `set-time-lock` (R13) | `{ on: true \| false }` | `setTimeLock`: on is immediate (`executed`); off is `scheduled` behind the delay. While on, both vaults' `withdraw`, `ringFence`, `unpause` and `setGuardian` are scheduled like guarded calls (`withdraw`, `ring-fence`, `resume` and the guardian rotation return `scheduled`; `escrow-fund` is refused `409 time_locked`). `409 nothing_to_change`, `409 time_lock_change_pending`, `409 owner_options_unavailable` | admin threshold |

Other refusals: `409 signer_exists`, `409 too_many_signers` (16 at most), `409 recovery_key_spent`,
`404 unknown_signer`, `409 removal_already_scheduled`, `409 nothing_to_change`.

**Recovery** (a recovery key is a raw P-256 key derived on the owner's device from a recovery code, never seen by the
rail; `chain/accounts/webauthn.ts` `RecoveryKey`): `add-signer` with `role: "recovery"` registers its public key. To
recover, `GET …/recovery/digest` gives the digest that commits to this account and chain, the recovery key, the new
passkey and a deadline (at most a day ahead); the recovery key signs it (ECDSA P-256 over SHA-256, as WebCrypto does;
the rail normalises s); `POST …/recoveries` relays `startRecovery`. Outcome `scheduled` with `{ recoveryId, readyAt }`
after the recovery delay (`QED_RAIL_ACCOUNT_RECOVERY_DELAY_S`, 72 h by default). The recovery key is spent by the
attempt. It is listed under `GET …/scheduled` as kind `recovery`; any one member cancels it with `cancel-change`
(which also removes the key); after the delay anyone finishes it with `POST …/scheduled/:recoveryId/apply`
(`finishRecovery`). A wrong code's signature, a key that is not a recovery key, a recovery already under way or a new
key that is already a signer end in `refused` with nothing sent.

**Links for the authority budget (R7 D7, A-ID).** Two workspaces are linked, so that neither counts as an outside
client of the other, when they share a signer now or ever (the account's `SignerAdded` history; removing a key does
not unlink), or when the wallet declared them linked because they have a member in common
(`POST …/links { workspaces }`; links are only ever added, on both sides).

**Earning through the proof escrow** (rail/escrow.ts). Jobs are between workspaces of this installation:

| Kind | Who | Params | What happens |
|---|---|---|---|
| `escrow-quote` | provider | `{ client, price, deliverWithinHours (1–336), validForMinutes? (15–10080, below the delivery time; 1440 by default), problem, title? }` | The passkey signs the owner account's replay-safe hash of the escrow's own quote digest (`toSign` kind `erc1271`, purpose `quote`). Payee: the provider's treasury vault; verifier: the shared MinVarianceVerifier; token tINR. Nothing is sent. `evidence { quote, signature, spec, quoteHash, problem }`. |
| `escrow-fund` | client | `{ quote, signature, spec? }` | One execute of the client's owner account: `QEDVault.withdraw` (free funds, to the owner account), `approve(escrow, price)`, `ProofEscrow.open`. `evidence { escrowJobId, quoteHash }`. |
| `escrow-deliver` | provider | `{ jobId, solution? }` | The certificate (the release's certifying solver unless `solution` is given) is first checked by `escrow.check` (the verifier, no state change); then `deliver` settles and pays the payee in the same transaction. |
| `escrow-release` | provider | `{ jobId }` | Before the deadline: `refund` by the provider; the client gets the price back. |

`problem` is `{ kind: "helix" }` (the release's illustrative six-asset model) or
`{ kind: "custom", assets: [{ name, volatilityBps }] }` (2 to 6 assets, 100 to 10000 basis points, zero
correlations; the covariance is built in exact integers). Refusals: `422 self_dealing` (a workspace cannot hire
itself), `422 unknown_client`, `422 unknown_provider`, `409 not_the_client`, `422 wrong_token`,
`422 unknown_verifier` (QED funds only quotes naming the shared verifier: the escrow pays on whatever its verifier
accepts), `409 quote_signature_invalid` (altered or not the provider's), `409 quote_used`, `409 quote_expired`,
`422 spec_mismatch`, `422 verification_failed` (the verifier's own error, for example `DualityGapTooLarge`; nothing
signed or sent), `409 job_not_open`, `409 not_the_provider`, `409 deadline_passed`, `409 spec_unknown`. After the
deadline anyone refunds an open job: `POST …/escrow/jobs/:jobId/refund` (no approval; before the deadline the job's
outcome is `refused`). There is no reviewer, oracle or dispute in this escrow: a certificate the verifier accepts
settles, and a job without one by its deadline returns to the client.

| Method and path | Request | Success | Errors |
|---|---|---|---|
| `GET /workspaces/:workspaceId/signers` | none | `200` `SignersView`: signers (role, serial, `frozen`, `pendingRemoval`, `pendingRecovery`), thresholds, member count, delays, `containment` (R13: the account's sentinel, whether it is this service's, whether the account has `protect`), pending signer changes, every signer ever | `422 unsupported_proposal` (not a passkey account) |
| `POST /workspaces/:workspaceId/signers/freeze` (R13) | `{ signerId }` and `Idempotency-Key` | `202` `Accepted`; job `freeze-signer` sends `QEDOwnerAccount.freeze` from the workspace's sentinel key (HKDF `workspace:<id>:sentinel`, which can do nothing else on the account): outcome `executed`, `no-action` (already frozen) or `refused` (not a member, or the account's sentinel is no longer this service's) | `422 invalid_params`, `409 no_sentinel` (an account built before R13), `400 idempotency_key_required` |
| `GET /workspaces/:workspaceId/ownership` (R13) | none | `200 { delaySeconds, mine, offeredToMe, ownedHere }`: who owns this workspace's two vaults (`mine`: `vault`, `which`, `owner`, `pendingOwner`, `pendingWorkspace`, `ownedByThisAccount`, `ownerWorkspace`) and any offer of them pending, the owner account's delay, and vaults of this installation offered to (`offeredToMe`) or owned by (`ownedHere`) this owner account, each with its balance | `422 unsupported_proposal` (not a workspace owned by a passkey account on the multi-tenant rail) |
| `GET /workspaces/:workspaceId/claims` (R13) | none | `200 { claims: ClaimView[] }`: liabilities of any vault of this installation that name, or named, this owner account as creditor (`liabilityId`, `vault`, `which`, `debtorWorkspace`, `creditor`, `amount`, `amountText`, `dueAt`, `dueTime`, `status` of `none`/`open`/`settled`/`released`, `due`, `mine`, `assignedTo`): the claims it can release or assign | `422 unsupported_proposal` |
| `POST /workspaces/:workspaceId/disputes/:disputeId/finish` (R13 E3) | `{}` and `Idempotency-Key` | `202` `Accepted`; job `escrow-finish`: the rail's relayer sends `QEDDisputeEscrow.finish` once the review or decision period has run out (anyone may then; no approval). Outcome `executed` (`evidence { disputeJobId, escrowJobId, toProvider, toClient, outcome }`), `refused` (the period has not run out; nothing sent) or `no-action` (the job is not delivered or disputed) | `422 invalid_params` (not a job number), `404 unknown_dispute_job` (no such job, or this workspace is neither a party nor the decider), `422 unsupported_proposal`, `409 not_finished` |
| `GET /workspaces/:workspaceId/recovery/digest` | `?recoverySignerId=&x=&y=&deadline=` | `200` `RecoveryDigest` | `422 invalid_query`, `422 invalid_params`, `409 not_a_recovery_key`, `409 recovery_pending`, `409 signer_exists` |
| `POST /workspaces/:workspaceId/recoveries` | `{ recoverySignerId, newKey: { x, y }, deadline, signature: { r, s }, cosign? }` and `Idempotency-Key`; `cosign` (R13): the guardian's passkey assertion `{ publicKey, authenticatorData, clientDataJSON, signature }` over the same digest, required while the account has a guardian (`GET …/recovery/digest` names it in `guardian`) | `202` `Accepted`; outcome `scheduled` (with `cosignedBy` when co-signed) or `refused` (no co-signature, another passkey's, or one over another recovery) | `422 invalid_params`, `400 idempotency_key_required` |
| `GET /workspaces/:workspaceId/recoveries/:recoveryId/withdraw-digest` (R13 review fix F1) | none | `200 { account, chainId, recoveryId, digest, guardian, note }`: what the guardian's passkey signs to withdraw its co-signature (the account's cancel digest for this recovery) | `409 change_not_pending` (finished or cancelled), `409 not_cosigned` (any member cancels it instead), `409 owner_options_unavailable`, `422 invalid_params` |
| `POST /workspaces/:workspaceId/recoveries/:recoveryId/withdraw` (R13 review fix F1) | `{ assertion }`: the guardian's passkey assertion `{ publicKey, authenticatorData, clientDataJSON, signature }` over the withdraw digest, and `Idempotency-Key` | `202` `Accepted`; job `guardian-withdraw`: the rail relays `QEDOwnerAccount.cancel` with the guardian's assertion; outcome `executed` (the recovery is dropped and its recovery key spent) or `refused` (not co-signed, not pending, another passkey's assertion, or one over something else) | `422 invalid_params`, `400 idempotency_key_required` |
| `POST /workspaces/:workspaceId/recoveries/:recoveryId/stop` (R13 H1) | `{}` and `Idempotency-Key`. The wallet service decides nothing: QED's server asks it only for a member with a usable passkey and a fresh confirmation | `202` `Accepted`; job `sentinel-stop`: this workspace's sentinel key sends `QEDOwnerAccount.stopRecovery`; outcome `executed` (the co-signed recovery is dropped and its recovery key spent) or `refused` (not co-signed, not pending, no sentinel or another one, or an account built before it) | `422 invalid_params`, `400 idempotency_key_required` |
| `POST /workspaces/:workspaceId/links` | `{ workspaces: [id, …] }` (up to 64) | `200 { linked, added, unknown }` | `422 invalid_params` |
| `GET /workspaces/:workspaceId/escrow/jobs` | `?quoteHash=` optional | `200 { jobs: EscrowJobView[] }` | `422 invalid_query` |
| `GET /workspaces/:workspaceId/escrow/jobs/:jobId` | none | `200` `EscrowJobView`, with `authority` for the payee: `credited`, `pending`, `not-earnings` or `not-settled`, the credit and why | `404 unknown_escrow_job` (also when this workspace is not a party) |
| `POST /workspaces/:workspaceId/escrow/jobs/:jobId/refund` | `{}` and `Idempotency-Key` | `202` `Accepted`; outcome `executed`, `refused` (before the deadline) or `no-action` | `404 unknown_escrow_job` |
| `POST /workspaces/:workspaceId/escrow/problems/preview` | `{ problem }` | `200 { problem, specHash, certified, weights, variance }` | `422 invalid_params` |

Real output of this service (multi-tenant, delays of 60 s, long values shortened with `…`):

```text
GET /workspaces/asha-home/signers
200 {"account":"0xB3204dfE…","signers":[{"signerId":"0xf323e2f5…","x":"0xd95e7e48…","y":"0x89c336d6…","role":"member","serial":"1",
     "pendingRemoval":null,"pendingRecovery":null}],"threshold":1,"adminThreshold":1,"memberCount":1,"delaySeconds":60,
     "recoveryDelaySeconds":60,"pending":[],"everSigners":["0xf323e2f5…"],"rules":["Adding a signer takes 1 member signature over the
     exact terms and applies at once: …", …]}

POST /workspaces/asha-home/proposals
> {"kind":"add-signer","params":{"x":"0x…","y":"0x…","role":"member"}}
201 {"kind":"add-signer","summary":"Add a passkey (0x2cc0d86f…) as a member of the owner account, at once.","terms":{ …,"toSign":[{"kind":
     "execute","threshold":1,"calls":[{"action":"QEDOwnerAccount.addSigner", …}],"digest":"0x7aa1d859…"}]}}
    executed with the passkey: "result":{"outcome":"executed","summary":"Added a passkey (0x2cc0d86f…) as a member of the owner account;
    2 members now, threshold 1.","evidence":{"signerId":"0x2cc0d86f…","role":"member","serial":"2"}}

GET /workspaces/asha-home/recovery/digest?recoverySignerId=0xdccf3ae2…&x=0x58cc0124…&y=0x8371660a…&deadline=1795345930
200 {"account":"0xB3204dfE…","chainId":31337,"recoverySignerId":"0xdccf3ae2…","newKey":{"x":"0x58cc0124…","y":"0x8371660a…"},
     "newSignerId":"0xe7df3fb4…","deadline":"1795345930","digest":"0xdb51789f…","recoveryDelaySeconds":60,"note":"The recovery key signs
     these 32 bytes with ECDSA P-256 over SHA-256 …"}

POST /workspaces/asha-home/recoveries        Idempotency-Key: cap-…
> {"recoverySignerId":"0xdccf3ae2…","newKey":{"x":"0x58cc0124…","y":"0x8371660a…"},"deadline":"1795345930","signature":{"r":"0x…","s":"0x…"}}
202 {"jobId":"f311e785-…","kind":"start-recovery","status":"accepted","duplicate":false}
    "result":{"outcome":"scheduled","summary":"Recovery: add the passkey 0xe7df3fb4… as a member. Started: it can be finished from
    2026-11-22T11:03:11.000Z; any member can cancel it until then.","evidence":{"recoveryId":"0x42eb03f8…","readyAt":1795345391, …}}

GET /workspaces/asha-home/recoveries/0x42eb03f8…/withdraw-digest
200 {"account":"0xB3204dfE…","chainId":31337,"recoveryId":"0x42eb03f8…","digest":"0x5c1a…","guardian":"0x9d3e…","note":"The
     guardian's passkey signs these 32 bytes as a WebAuthn challenge …"}

POST /workspaces/asha-home/recoveries/0x42eb03f8…/withdraw        Idempotency-Key: vwd-…
> {"assertion":{"publicKey":{"x":"0x…","y":"0x…"},"authenticatorData":"0x…","clientDataJSON":"{…}","signature":"0x…"}}
202 {"jobId":"…","kind":"guardian-withdraw","status":"accepted","duplicate":false}
    "result":{"outcome":"executed","summary":"The guardian withdrew its co-signature: the recovery 0x42eb03f8… is cancelled and its
    recovery key spent.","evidence":{"recoveryId":"0x42eb03f8…","withdrawnBy":"0x9d3e…"}}

POST /workspaces/asha-home/recoveries/0x42eb03f8…/stop        Idempotency-Key: vst-…
> {}
202 {"jobId":"…","kind":"sentinel-stop","status":"accepted","duplicate":false}
    "result":{"outcome":"executed","summary":"QED stopped the recovery 0x42eb03f8… with this wallet's sentinel key: it is
    cancelled and its recovery key spent.","evidence":{"recoveryId":"0x42eb03f8…","stoppedBy":"0x…"}}

POST /workspaces/asha-home/links
> {"workspaces":["ravi-home"]}
200 {"linked":["ravi-home"],"added":["ravi-home"],"unknown":[]}

POST /workspaces/asha-home/escrow/problems/preview
> {"problem":{"kind":"custom","assets":[{"name":"Alpha","volatilityBps":1500},{"name":"Beta","volatilityBps":3000}]}}
200 {"problem":{"kind":"custom","title":"Minimum-variance long-only portfolio of 2 assets", …},"specHash":"0x58c98f5e…","certified":true,
     "weights":[{"asset":"Alpha","weight":"80.0000%"},{"asset":"Beta","weight":"20.0000%"}],"variance":"18000000000000000"}

    escrow-quote executed with the provider's passkey: "result":{"outcome":"executed","summary":"Signed the quote \"Minimum-variance
    sleeve\" for 250.50 tINR to 0x01e8be64…; the client may fund it until 2026-11-22T12:02:11.000Z. No money moved.", …}
    escrow-fund, toSign calls ["QEDVault (treasury).withdraw","TestToken (tINR).approve","ProofEscrow.open"], executed with the client's
    passkey: "result":{"outcome":"executed","summary":"Funded escrow job #1 with 250.50 tINR from the treasury vault; the provider is paid
    only for a verified certificate by 2026-11-22T13:02:11.000Z.","evidence":{"escrowJobId":"1", …}}

GET /workspaces/kiran-home/escrow/jobs
200 {"jobs":[{"jobId":"1","status":"open","roles":["client"],"client":"0x01e8be64…","provider":"0xB3204dfE…","payee":"0xA03A33BD…",
     "price":"25050","priceText":"250.50 tINR","deliverByTime":"2026-11-22T13:02:11.000Z","refundable":false,"opened":{"tx":"0xcb362d62…",
     "block":"86"},"settled":null,"refunded":null,"authority":null, …}]}

    escrow-deliver, evidence {"weights":[{"asset":"Alpha","weight":"80.0000%"},{"asset":"Beta","weight":"20.0000%"}],"variance":
    "18000000000000000","checks":{"dualityGap":"0", …}}, executed: "summary":"Delivered job #1: the verifier accepted the certificate and
    the escrow paid 250.50 tINR into this vault."

GET /workspaces/asha-home/escrow/jobs/1
200 {"jobId":"1","status":"settled","roles":["provider","payee"], …,"settled":{"tx":"0x68ce7f6e…","block":"87","confirmations":1},
     "authority":{"status":"pending","credit":"0","creditText":"0.00 tINR","confirmations":1,"needed":2,"why":"Settled with 1
     confirmation; the budget counts it after 2."}}
    one block later: "authority":{"status":"credited","credit":"12525","creditText":"125.25 tINR","confirmations":2,"needed":2,"why":
    "Earned: half the price, from a client this workspace does not know to be its own (it shares no member or key with it). …"}

POST /workspaces/kiran-home/escrow/jobs/2/refund        Idempotency-Key: cap-…
> {}
202 {"jobId":"cd917fef-…","kind":"escrow-refund","status":"accepted","duplicate":false}
    before the deadline: "result":{"outcome":"refused","summary":"Job #2 can be refunded by anyone only after its deadline,
    2026-11-22T12:02:11.000Z; before it, only the provider can release the client. Nothing was sent."}
    after it: "result":{"outcome":"executed","summary":"Refunded job #2 after its deadline: the escrow returned 40.00 tINR to the client's
    owner account 0x01e8be64…. No valid certificate arrived in time, so nothing was paid to the provider."}
```

Request forms of four more routes (written, not captured from a running service: each answer has the shape the table
gives; `ownership.test.ts`, `disputes.test.ts` and `containment.test.ts` exercise them):

```text
POST /workspaces/asha-home/signers/freeze        Idempotency-Key: cap-…
> {"signerId":"0x…"}
202 {"jobId":"…","kind":"freeze-signer","status":"accepted","duplicate":false}

GET /workspaces/asha-home/ownership
200 {"delaySeconds":60,"mine":[{"vault":"0x…","which":"treasury","owner":"0x…","pendingOwner":null, …}, …],"offeredToMe":[],"ownedHere":[]}

GET /workspaces/asha-home/claims
200 {"claims":[]}

POST /workspaces/asha-home/disputes/1/finish        Idempotency-Key: cap-…
> {}
202 {"jobId":"…","kind":"escrow-finish","status":"accepted","duplicate":false}
```

## Refutation bounties: a claim path that pays the committed finder (R11 §9, R10-009; 24 Nov 2026)

The release's two original 1,000-tUSD bounties, `OptimalityBounty` and `MaximalityBounty`, pay their whole balance to
`msg.sender` of the first valid claim, so a copied pending claim pays the copier (EV-077). On this chain the same
contracts, unmodified and deployed from the release's embedded bytecode, are the judges of a `QEDBountyBoard`
(`chain/bounties/src/QEDBountyBoard.sol`, built by `chain/bounties/scripts/export-artifacts.mjs` into
`chain/bounties/artifacts/`), which holds each pool and pays only through commit, reveal and settle (rail/bounties.ts):

- **At start** (multi-tenant only) the host deploys the board once per shared chain, one dedicated judge per bounty
  (`OptimalityBounty` over the market's `MinVarianceVerifier`, and `MaximalityBounty`), opens each and funds it with
  1,000 tUSD. Bounty 1 is the optimality bounty and bounty 2 the maximality bounty. The record is the host's meta
  `bounties`, written after the chain state holding it was checkpointed; a restart reuses it. On a chain created
  before this, the board is added at the next start. `QED_RAIL_BOUNTIES=0` turns it off.
  **Tests only:** `QED_RAIL_BOUNTY_CONTROLS=1` also opens the release's positive controls as bounties 3 and 4 (the
  optimality bounty over a verifier that accepts anything, and the netting rule that under-reports by 7 tUSD; built
  from the unmodified `vendor/contracts/test/Bounties.t.sol`), labelled `positive-control` in every view.
- **Judges (R13, 24 Nov 2026).** The board opens a bounty only with a judge whose runtime code hash (EXTCODEHASH, which
  covers its immutables: the token and the verifier) is on its allowlist, because a judge that keeps the pool, or refuses
  every claim, would strand the bounty's money (a funded pool leaves only through settle). The host deploys the judges
  first and the board with exactly their code hashes allowed (the four above when the controls are on); its deployer key
  may change the list, which affects only bounties opened afterwards. A board recorded before R13 has no list and keeps
  working as it did. Evidence of this build: `chain/bounties/evidence/r13-judges/` (the earlier files in
  `chain/bounties/evidence/` are kept as history); tests: `chain/bounties/test/JudgeAllowlist.t.sol`, the seeded twin
  `UncheckedJudgesChecks`, and `chain/test/bounties.test.ts` on the served stack.
- **A commitment** is the EIP-712 digest of `Claim(uint256 bountyId,address claimant,address recipient,bytes claim,bytes32 salt)`
  under the domain `("QED Bounty Board", "1", 31337, board)`: the bounty, the workspace's claimant key (derived from
  this installation's secret, label `workspace:<id>:bounty-claimant`; it holds no owner authority), the recipient
  (`payTo`: the workspace's tUSD reserve vault by default, or its owner account), the claim's exact calldata and a
  random salt that stays in the workspace's store. The service computes it and the board computes it, and they must
  agree before anything is sent. The commit transaction carries the digest only.
- **Periods**, fixed for each bounty when it is opened: a commitment may be revealed `QED_RAIL_BOUNTY_REVEAL_DELAY_S`
  (default 60) after it was mined and expires `QED_RAIL_BOUNTY_REVEAL_WINDOW_S` (default 86400) later; the first valid
  reveal opens a contest of `QED_RAIL_BOUNTY_CONTEST_S` (default 300) during which a valid reveal of a strictly older
  commitment takes over; then anyone settles. `QED_RAIL_BOUNTY_AUTO` (default on) has the heartbeat reveal a
  workspace's claims as soon as they may be revealed and settle its winning ones, each as a job under a fixed key.

A claim is `{ calldata }` (the judge's `claim` call, hex) or its fields: for the optimality bounties
`{ spec: { n, cov, tol, universe? }, certificate: { w, nu, mu, L }, x }`, for the maximality bounties
`{ economy: { members, debtor, creditor, d }, certified: { x, potential, y }, larger }`, every integer a decimal
string, exactly as the contracts take them (W = 10^18 scale; amounts in micro-tUSD). The routes check shape only;
the judge rules. A claim may be up to 48 KiB of calldata, and these two routes accept bodies up to 128 KiB.

Claim states in the view: `committing`, `committed` (not revealable yet), `revealable`, `leading`, `overtaken` (an older
commitment took over), `won`, `lost`, `expired` (never revealed in its window), `too-late` (never revealed, and it can
no longer win). The salt is never shown. Refusals: `422 invalid_claim`, `404 unknown_bounty`, `404 unknown_claim`,
`422 claim_rejected` (the judge's own error in `details.error`: nothing recorded), `409 bounty_not_open` (a valid claim
was already revealed, so a commitment recorded now could not win; or the bounty is paid), `409 too_many_claims` (64
per workspace), `503 bounties_unavailable`. A reveal or settlement the board would refuse ends in `refused` with the
board's reason (`TooEarly`, `Expired`, `NotFirst`, `ContestClosed`, `ContestOpen`) and nothing sent.

| Method and path | Request | Success | Errors |
|---|---|---|---|
| `GET /workspaces/:workspaceId/bounties` | none | `200` the board (address, domain, artifact hashes, `auto`: whether this service reveals and settles a workspace's claims on its own) and each bounty (`id`, `key`, `role`, `judge`, `phase` of `open`, `contest`, `settleable` or `settled`, `pool`, `winner`, `recipient`, `contestEndsAt`, `periods`), plus this workspace's `claimant`, `recipients` and `claims` | `503 rail_starting` |
| `POST /workspaces/:workspaceId/bounties/:bountyId/check` | `{ claim }` | `200 { valid, claimHash, claimBytes, error?, words }`; nothing recorded or sent | `422 invalid_claim`, `404 unknown_bounty` |
| `POST /workspaces/:workspaceId/bounties/:bountyId/claims` | `{ claim, payTo? }` and `Idempotency-Key` | `202` `Accepted`; outcome `executed` with `evidence { claimId, seq, revealableAt, expiresAt, claimant, recipient }` | `422 claim_rejected`, `409 bounty_not_open`, `422 invalid_claim` |
| `POST /workspaces/:workspaceId/bounties/claims/:claimId/reveal` | `{}` and `Idempotency-Key` | `202` `Accepted`; outcome `executed` (`evidence { contestEndsAt, replaced }`), `refused` or `no-action` (already revealed) | `404 unknown_claim` |
| `POST /workspaces/:workspaceId/bounties/:bountyId/settle` | `{}` and `Idempotency-Key` | `202` `Accepted`; outcome `executed` (`evidence { winner, recipient, payout }`), `refused` (no winner or the contest is open) or `no-action` | `404 unknown_bounty` |

Real output of this service (multi-tenant, `QED_RAIL_BOUNTY_CONTROLS=1`, delay 3 s, contest 5 s; long values shortened
with `…`). BA1 is the first of the five claims recorded on Sepolia on 19 Oct 2026; the judge's error and arguments are
the recorded ones:

```text
GET /workspaces/asha-home/bounties
200 {"status":"ready","board":"0xD008f226…","chainId":31337,"token":"0x4a19dd9C…","tokenSymbol":"tUSD","domain":{"name":"QED Bounty Board",
     "version":"1","chainId":31337,"verifyingContract":"0xD008f226…","separator":"0x485db1c0…"},"claimType":"Claim(uint256 bountyId,address
     claimant,address recipient,bytes claim,bytes32 salt)","deployBlock":"47","artifact":{"bytecodeSha256":"a30af94e…","sourceSha256":
     "eac8f051…"},"bounties":[{"id":"1","key":"optimality","kind":"optimality","role":"original","judge":"0x144b311a…","title":
     "OptimalityBounty: money on Theorem 4.4, …","phase":"open","pool":"1000000000","poolText":"1,000.00 tUSD","paid":"0","winner":null,
     "recipient":null,"contestEndsAt":null,"periods":{"revealDelaySeconds":3,"revealWindowSeconds":86400,"contestSeconds":5},
     "selector":"0x88c7acb3"}, …],"claimant":"0xDB9892D5…","recipients":{"reserve":"0x57d6D922…","ownerAccount":"0x…"},"claims":[]}

POST /workspaces/asha-home/bounties/1/check
> {"claim":{"calldata":"0x88c7acb3…"}}
200 {"bountyId":"1","key":"optimality","role":"original","valid":false,"claimHash":"0x0075d445…","claimBytes":2980,"error":{"name":
     "TheoremHolds","args":["-17427890834445872562219109117693616905377777777777792","30005320910997774926000000000000000000000000000"],
     "words":"The theorem holds for this claim: …"},"words":"…"}

POST /workspaces/asha-home/bounties/1/claims        Idempotency-Key: cap-…
> {"claim":{"calldata":"0x88c7acb3…"}}
422 {"error":{"code":"claim_rejected","message":"The judge rejects this claim, so it cannot be paid: The theorem holds for this claim: …",
     "details":{"error":{"name":"TheoremHolds","args":["-17427890834445872562219109117693616905377777777777792", "30005320910997774926…"]}}}}

POST /workspaces/asha-home/bounties/3/claims        Idempotency-Key: cap-…
> {"claim":{"calldata":"0x88c7acb3…"}}
202 {"jobId":"01eacb54-…","kind":"bounty-commit","status":"accepted","duplicate":false}
    "result":{"outcome":"executed","summary":"Committed a claim to bounty 3 (Positive control (tests only)): commitment #1 by 0xDB9892D5….
    It may be revealed from 2026-11-23T22:14:45.000Z until 2026-11-24T22:14:45.000Z; the claim stays private until then.","evidence":
    {"claimId":"0xaa788116…","bountyId":"3","seq":"1","committedAt":1795472082,"revealableAt":1795472085,"expiresAt":1795558485, …}}

POST /workspaces/asha-home/bounties/claims/0xaa7881166ab036478c07260fde452f0e50a25f7f5077d4995afbcdbcd8caa722/reveal        Idempotency-Key: cap-…
> {}
202 {"jobId":"9dd73893-…","kind":"bounty-reveal","status":"accepted","duplicate":false}
    "result":{"outcome":"executed","summary":"Revealed claim 0xaa788116… on bounty 3: the judge accepted it and this workspace's claimant
    leads. The pool (1,000.00 tUSD) goes to 0x57d6D922… at settlement, from 2026-11-23T22:14:52.000Z, unless an older commitment is
    revealed before then.","evidence":{"claimId":"0xaa788116…","bountyId":"3","contestEndsAt":1795472092,"replaced":null,"pool":"1000000000"}}

POST /workspaces/asha-home/bounties/3/settle        Idempotency-Key: cap-…
> {}
202 {"jobId":"ebaa7022-…","kind":"bounty-settle","status":"accepted","duplicate":false}
    "result":{"outcome":"executed","summary":"Settled bounty 3: the board paid 1,000.00 tUSD to 0x57d6D922…, this workspace's recipient.
    Anyone may settle; the board pays only the recorded recipient, once.","evidence":{"bountyId":"3","winner":"0xDB9892D5…","recipient":
    "0x57d6D922…","payout":"1000000000","ours":true}}
```

What a copier gets, shown by `test/bounties.test.ts` on this service with an adversary watching its Anvil's mempool:
a byte-for-byte copy of the pending reveal, or one paying itself, reverts `NoCommitment` (the board recomputes the
digest with the copier as claimant); a copy of the commit records a digest it can never reveal; the claim sent
straight to the judge is paid the judge's balance, 0; its own commitment, made after it saw the claim, is younger and
reverts `NotFirst`; another workspace asking this service to claim it is refused `409 bounty_not_open`. Its
transactions were mined ahead of the finder's, and the finder's vault received the 1,000 tUSD. Limits (the board's
NatSpec): the finder is protected if its reveal is mined within the delay plus the contest of being broadcast, and
before its commitment expires; tokens sent straight to a judge are unprotected until the next reveal sweeps them in.

## How the backend uses it

This section, and the route tables below, describe one workspace. Everything here holds in a passkey workspace too,
with the differences stated in "The multi-tenant HTTP contract (R7)" above: a sixth approval field `signatures`,
checked on chain; `provision` means accepting ownership; some owner changes are scheduled. The examples are from the
baseline-parity workspace.

Import the types and the terms hash without any loader:

```ts
import type { Proposal, Approval, Job, RailState } from "../chain/types.ts";
import { hashTerms } from "../chain/terms.ts";       // dependency-free; also checkApproval, canonicalTerms
```

Every action that needs the owner (or the guardian) has two steps, and the rail signs nothing on its own initiative:

1. `POST /proposals { kind, params }` returns the **exact terms** to be signed or sent and `termsHash`
   (`"sha256:" + sha256(canonical JSON of terms)`). Nothing is signed. A proposal is one-use and expires after ten
   minutes. Show `terms` to the authenticated owner.
2. `POST /proposals/:id/execute { approval }` with an `Idempotency-Key` header, where
   `approval = { approvalId, docHash, termsHash, confirmedAt, method }`. The rail recomputes the hash of the terms
   it is about to sign, refuses unless it equals `approval.termsHash`, stores the approval with the decision record,
   and answers `202 { jobId }`. Follow the job with `GET /workspaces/:workspaceId/jobs/:id` or the event stream.

Rules the backend can rely on:

- **Idempotency is mandatory and durable.** The same key with the same body returns the original job
  (`duplicate: true`); with a different body it is `409 idempotency_conflict`. Keys, jobs, proposals, decision
  records and receipts are in SQLite and survive a restart. After a lost response, ask `GET /workspaces/:workspaceId/submissions/:key`;
  never send again under a new key.
- **An approval works once.** `approvalId` is unique; a second use is `409 approval_replayed`. `confirmedAt` must
  lie between the proposal's creation and expiry.
- **Proposal kinds** (signers and earning: see "Signers, recovery and earning" above: `add-signer`, `remove-signers`,
  `set-thresholds`, `escrow-quote`, `escrow-fund`, `escrow-deliver`, `escrow-release`): `provision`, `mandate`, `convert`, `attack`, `policy`, `policy-revoke`, `scenario`, `pause`,
  `guardian-pause`, `resume`, `revoke-mandate`, `void-all`, `rotate-key`, and on the main treasury `pay`,
  `ring-fence`, `withdraw`, `deposit`, `venues` (tables below). The first thing a fresh rail needs is a `provision`
  approval: the contracts are deployed at start, but the two owner transactions that wire them (`setAgent`,
  `setVenues`) are the owner's to approve. Then a `mandate`.
- **Without an approval** (no principal signs): `POST /workspaces/:workspaceId/policy/tick`, `POST /workspaces/:workspaceId/policy/run`, `POST /workspaces/:workspaceId/economies/run` and
  `POST /workspaces/:workspaceId/liabilities/:id/settle`. They still need an `Idempotency-Key`. A tick acts only under a policy the owner
  already signed; a settlement pays only a liability that is due, only to its creditor, as the contract lets anyone do.
- **The rail has its own budget** (`GET /workspaces/:workspaceId/quota`): in any rolling hour at most 240 proposals prepared, 240 operations
  accepted and 4 scripted economies started. One more is `429 quota_exceeded` with a `Retry-After` header; nothing is
  stored for it, so the same key and approval can be sent again later. A repeated request under an accepted key is
  not counted. The count is in the database and survives a restart. Reads are not counted. Limits per signed-in
  owner are the backend's.
- **Money** is a decimal string of raw token units in every response (`"10000000"` is 10 tUSD; tUSD and tEUR have
  6 decimals). **Inputs** are human decimal strings with at most six decimals (`"22.5"`), parsed by the release's
  own strict parser; `.5`, `1e2`, `-10`, `1_000` and numbers are refused.
- **A job that fails says why in words.** When a contract refuses a transaction at gas estimation the error is decoded:
  `The contract refused this transaction before it was broadcast: OverConversion(59801210, 10198790, 70000000). Nothing was sent.`
  When the chain is ahead of the wall clock: `clock_skew` with both times. A transaction mined as a revert: `mined_revert`.
- **Job status:** `accepted` → `running` → (`confirming` →) `done` | `failed` | `interrupted` | `reorged`. `done` carries
  `result.outcome`: `executed`, `refused` (no transaction), `reverted` (mined as a revert), `no-action`, or `error`
  with `doNotRetry: true` (mined, but balances did not reconcile). `failed` and `interrupted` carry `guidance`
  saying whether anything was mined. `interrupted` means the service stopped mid-operation and the restored chain
  does not contain it; it was not sent again. R7-036: a job that sent transactions on the shared chain is `done` only
  once each has `QED_RAIL_CONFIRMATIONS` confirmations (the block itself counts as one); until then it is `confirming`
  with its `result` and `confirmations { have, need, block }`. `reorged`: a reorganisation replaced the block that held
  its transaction, before its confirmations (it was never reported done) or after; nothing is sent again, and if the
  same transaction is mined again the job waits for its confirmations again. Transactions sent on an ephemeral chain
  (Security Lab, scenarios) are never looked for on the shared chain.
- **Clock.** `GET /workspaces/:workspaceId/state` and every decision record carry `clock: { wallTime, wallSeconds, chainSeconds,
  skewSeconds, limitSeconds, withinLimit }`. When the chain is ahead of the wall clock by more than the limit, every
  transaction is refused with `clock_skew` and both times in the message.

### What the backend should know before wiring (answers to the questions that came up)

- **Idempotency-Key** may be any string of 8 to 128 characters from `A-Z a-z 0-9 . _ : -`. An approval id, a UUID,
  `sched-<policyId>-<slot>` and `ui-<uuid>` all qualify. Using the approval id as the key for
  `POST /workspaces/:workspaceId/proposals/:id/execute` works: a request that is refused with a 4xx stores nothing, so the key stays free.
- **`approval` has exactly five fields in the baseline-parity workspace.** A sixth is `422 approval_malformed`. In a passkey workspace the sixth, `signatures`, is required whenever the terms carry `toSign`, and any other extra field is still refused. `docHash` is opaque to the rail (any
  non-empty string up to 200 characters); `method` likewise (`"password"`, `"recent-password"`, …).
- **`confirmedAt` is the moment the owner confirmed *this* proposal.** It must not be earlier than the proposal's
  `createdAt` (5 s leeway), later than its `expiresAt`, or in the future. With a "recent password" flow, send the time
  of the confirmation click, not the time the password was typed, or the rail answers `409 approval_predates_terms`.
- **One key, one outcome.** A scheduler key such as `sched-<policyId>-<five-minute slot>` returns the *same job* for
  the whole slot, whatever its outcome: a tick that failed (no mandate, clock ahead, contract refusal) is not tried
  again under that key. Use a new key to try again deliberately.
- **`202` is acceptance, not execution.** Read the job: `done` with `outcome: "refused"` means nothing was sent (for
  example the amount broke a limit, or the mandate changed after the proposal was prepared, in which case prepare a
  new proposal). `failed` and `interrupted` carry `guidance` to show the owner.
- **Proposals replace each other by kind** for `provision`, `mandate`, `policy`, `policy-revoke`, `pause`,
  `guardian-pause`, `resume`, `revoke-mandate`, `void-all`, `venues`: preparing a new one cancels the open one
  (`409 proposal_cancelled` if the old one is executed). `revoke-mandate` and `void-all` also cancel an open `mandate`.
  `convert`, `attack`, `scenario`, `rotate-key`, `pay`, `ring-fence`, `withdraw` and `deposit` proposals do not
  replace each other.
- **Recompute the hash** with `hashTerms(terms)` from `chain/terms.ts` before showing terms to the owner: if it differs
  from `termsHash`, something changed the terms in between and the rail would refuse the approval anyway.
- **A fresh rail needs two approvals before anything else**: `provision`, then `mandate`. Until then `GET /workspaces/:workspaceId/state` has
  `provisioned: false`, `venues: []`, `mandate: null`, and other proposals answer `409 not_provisioned` or `no_mandate`.
  `venues` lists only what the owner has named on-chain; before provisioning the five pools the `provision` proposal
  will name are in `plannedVenues` (labels, fees, tokens, reserves), which is empty once a venue set is named.
- **The writer's queue is bounded.** At most 16 accepted operations may be running or waiting for the single
  writer; one more is `429 busy` and stores nothing, so the same key and approval can be sent again shortly.
- **Payments from the main treasury are small by the co-signer's check C12.** In the baseline-parity workspace it is
  the release's: 10 tUSD plus half of the revenue that settled into the vault through an escrow, every amount the
  vault has paid out under a certificate counted, conversions included, so `pay` stops once conversions and payments
  together reach 10 tUSD; the proposal's `earned-autonomy` check shows the figure. In a workspace it is the authority
  budget of R7 decision D7 (see "Amounts in a workspace"): 10 tINR granted at the start, used by payments and by
  conversions' costs only, raised by owner grants (`grant`, signed by passkey) and by escrow earnings from outside
  clients; the proposal's `authority-budget` check and `GET …/payments/limits` (`authority`) show the co-signer's
  own figures. Show the owner `granted` and `earned` apart. And while a contract-enforced policy is wired, `pay`
  answers `409 policy_contract_wired` (baseline W-12).
- **Do not switch `QED_RAIL_COSIGNER` on an existing data folder.** The vault knows one co-signer address; a rail
  started under the other arrangement refuses to start and says which setting the chain was created with.
- **Upgrading the code under a running rail** takes effect at its next start. A start re-checks all vendored files
  against `VENDORED.json` and refuses to load release code that fails the check.
- **Ports besides 5176 and 8546**: a scripted economy uses 8547, and the `economy` script also 7701 to 7703, for the
  time it runs. A second rail on the same machine (tests) needs `QED_RAIL_PORT`, `QED_RAIL_ANVIL_PORT`,
  `QED_RAIL_ECONOMY_ANVIL_PORT` and its own `QED_RAIL_DATA`.

## Routes

All routes are JSON. All except `/health` need `Authorization: Bearer <token>`. A request with an `Origin` header
is refused (`403`): no browser may call this service and no CORS header is ever sent. The `Host` header must be a
loopback name (`421` otherwise). Bodies are at most 16 KB. Errors are always
`{ "error": { "code", "message", "details"? } }` without stack, path or RPC address.

Common errors on every route: `401 unauthorised`, `403 cross_origin_refused`, `421 wrong_host`, `404 not_found`,
`405 method_not_allowed`, `503 rail_starting | rail_unavailable`. On `POST`: `400 invalid_json`,
`413 body_too_large`, `415 unsupported_media_type`, `422 invalid_request`. On every route that prepares a proposal
or starts a job: `429 quota_exceeded` with `Retry-After` (seconds) and `details { class, limit, used, windowSeconds,
retryAfterSeconds, nextFreeAt }`. Examples below are real output of this service (long values shortened with `…`).

### Readiness and state

| Method and path | Request | Success | Errors |
|---|---|---|---|
| `GET /health` | none, no token | `200` `Health` when ready | `503` with the same body while starting or failed |
| `GET /workspaces/:workspaceId/state` | none | `200` `RailState` | `503` |
| `GET /workspaces/:workspaceId/clock` | `?limit=` (events, default 50) | `200 { clock, events[] }` | `422 invalid_query` |
| `GET /workspaces/:workspaceId/history` | `?limit=` (default 40, max 200) | `200 { history: HistoryEntry[] }` newest first | `422 invalid_query` |
| `GET /workspaces/:workspaceId/mandates` | none | `200 { mandates: MandateView[] }` newest first | |
| `GET /workspaces/:workspaceId/attacks` | none | `200 { attacks: AttackInfo[] }` (six) | |
| `GET /workspaces/:workspaceId/quota` | none | `200` `QuotaView`: per class the limit, what is used in the rolling window, what remains and when one more is allowed | |

```text
GET /workspaces/baseline/quota        (captured on a rail started with QED_RAIL_QUOTA_ECONOMIES=0, so that a refusal could be shown)
200 {"windowSeconds":3600,"classes":[{"class":"proposals","counts":"proposals prepared","limit":240,"used":15,
     "remaining":225,"nextFreeAt":null},{"class":"operations","counts":"operations accepted","limit":240,"used":10,
     "remaining":230,"nextFreeAt":null},{"class":"economies","counts":"scripted economies started","limit":0,"used":0,
     "remaining":0,"nextFreeAt":null}]}
    and, on that rail, POST /economies/run {"scenario":"clearing"}:
429 Retry-After: 3600
    {"error":{"code":"quota_exceeded","message":"The rail's budget for scripted economies started is spent: 0 in any
     hour. Nothing was stored or started.","details":{"class":"economies","limit":0,"used":0,"windowSeconds":3600,
     "retryAfterSeconds":3600,"nextFreeAt":null}}}
    With a limit above zero the message ends "…; the next one is allowed at <time>." and nextFreeAt is that time.

GET /health
200 {"status":"ok","ready":true,"readiness":{"rail":"ready","anvil":true,"contracts":true,"store":true,"cosigner":true,
     "vendored":true,"checkedAt":"2026-11-19T21:10:51.339Z"},"provisioned":false,
     "network":"Local Anvil chain 31337 · valueless test tokens · development keys",
     "versions":{"node":"v26.12.0","anvil":"anvil Version: 1.7.1","release":"qed-20261023-health-gate-v3"}}

GET /workspaces/baseline/state
200 {"status":"ready","genesisId":"19d2e81a-…","provisioned":true,"restoredFromState":false,
     "network":{"chainId":31337,"name":"Local Anvil chain 31337 · …","block":"36","timestamp":1795122651,"valueless":true},
     "clock":{"wallTime":"2026-11-19T21:10:51.803Z","wallSeconds":1795122651,"chainSeconds":1795122651,"skewSeconds":0,
              "limitSeconds":5,"withinLimit":true},
     "roles":{"owner":"0x81cB…","operator":"0x8b2F…","cosigner":"0x6664…","guardian":"0x52e0…","attacker":"0xd041…",
              "creditor":"0x7A66…","cosignerIsolation":"separate-process"},
     "contracts":{"vault":"0xF7C1…","reserve":"0xd5AB…","execution":"0xd053…","lens":"0x50c8…","tUSD":"0x6Fdd…",
                  "tEUR":"0x9532…","tETH":"0x2636…","pools":["0x4537…", …],"treasuryPolicy":"0x1c6a…"},
     "treasury":{"token":"tUSD","balance":"90000000","ringFenced":"0","free":"90000000","dailyCap":"100000000",
                 "spentInWindow":"10000000","availableToday":"90000000","worstCaseLoss24h":"90000000",
                 "worstCaseScope":"Transfers to payees the owner approved, within the vault's daily cap. It does not
                 cover value lost to price moves inside the approved venues (baseline W-09).","paused":false, …},
     "reserve":{"token":"tEUR","balance":"9107516","dailyCap":"0", …},
     "mandate":{"version":1,"hash":"0x60d2…","status":"active","fields":{ …thirteen fields… },
                "usage":{"perPayment":{"limit":"25000000"},
                         "period":{"limit":"100000000","spent":"10000000","remaining":"90000000", …},
                         "lifetime":{"limit":"200000000","spent":"10000000","remaining":"190000000"},
                         "validity":{"validFrom":…,"validUntil":…,"active":true,"secondsLeft":604799},
                         "vaultDaily":{"limit":"100000000","spent":"10000000","remaining":"90000000", …},
                         "revokedOnChain":false,"epochCurrent":true}},
     "policy":null,"venues":[{"i":0,"label":"tUSD/tEUR · 0.30% · deep","pool":"0x4537…","feeBps":30,"token0":"tEUR",
     "token1":"tUSD","r0":"…","r1":"…"}, …4 more],"plannedVenues":[],"lastTrade":{ …see TradeView… },"zkOptional":false}

GET /workspaces/baseline/state        before the `provision` proposal was approved: nothing is named yet, the planned set is shown
200 { …,"provisioned":false,"venues":[],"plannedVenues":[{"i":0,"label":"tUSD/tEUR · 0.30% · deep","pool":"0x4537…",
     "feeBps":30,"token0":"tUSD","token1":"tEUR","r0":"800000000","r1":"736000000"},{"i":1,"label":"tUSD/tEUR · 0.05% ·
     thin","pool":"0xf8fC…","feeBps":5,"token0":"tUSD","token1":"tEUR","r0":"250000000","r1":"230125000"}, …3 more], … }

GET /workspaces/baseline/clock?limit=1
200 {"clock":{"wallTime":"2026-11-19T21:10:51.808Z","wallSeconds":1795122651,"chainSeconds":1795122651,"skewSeconds":0,
     "limitSeconds":5,"withinLimit":true},
     "events":[{"n":1,"at":"2026-11-19T21:10:47.963Z","kind":"start","note":"fresh chain deployed", …}]}

GET /workspaces/baseline/history?limit=2
200 {"history":[{"n":5,"at":"…","kind":"attack","title":"Redirect the order's output to Mallory → reverted on-chain with
     OrderMismatch.","outcome":"reverted","tx":{"hash":"0x1c89…","status":"reverted","block":"36","gasUsed":"61910",
     "error":"OrderMismatch"},"jobId":"689a…"},{"n":4,"kind":"conversion","title":"Converted 10.00 tUSD → 9.107516 tEUR;
     bound 9.107519; reserve now 9.107516 tEUR.","outcome":"executed","tx":{…},"trade":{…},"jobId":"8c59…"}]}

GET /workspaces/baseline/mandates
200 {"mandates":[{"version":1,"hash":"0x60d2…","status":"active","fields":{…},"payeeLabels":["QEDExecution (conversion
     module)","Euro reserve","CloudCo"],"purposeText":"Convert surplus tUSD into the euro operating reserve, with best
     execution proved on-chain","signedAt":"…","approvalId":"ap-example-2","usage":{…}}]}

GET /workspaces/baseline/attacks
200 {"attacks":[{"kind":"inferior-route","title":"Route over the direct pools only (what a single-pair router would
     pick)","expect":"NotBestExecution","layer":"QEDExecution: realised output below the dual bound"}, …5 more]}
```

### Read-only checks (WF-2): nothing is signed, no job is created

| Method and path | Request | Success | Errors |
|---|---|---|---|
| `GET /workspaces/:workspaceId/limits` | `?amount=22.5` | `200` `LimitsResult`: every rule with `limit`, `used`, `remaining`, `pass`; `maximum` | `422 invalid_amount` |
| `GET /workspaces/:workspaceId/maximum` | none | `200 { maximum, checks, note, execution: "none" }` | |
| `GET /workspaces/:workspaceId/quote` | `?amount=12.5` | `200` `QuoteResult` with `source` and freshness; `allowed: false` and no figures when a limit is broken | `422 invalid_amount`, `409 not_provisioned` |

```text
GET /workspaces/baseline/limits?amount=80
200 {"amount":"80000000","allowed":false,"maximum":"25000000","execution":"none","checks":[
     {"id":"amount","rule":"Amount is positive and at most 6 decimals","limit":"1","used":null,"remaining":null,"pass":true},
     {"id":"mandate-valid", …,"pass":true},
     {"id":"per-conversion","rule":"Per-conversion limit in the owner's signed mandate","limit":"25000000","used":null,
      "remaining":"25000000","pass":false},
     {"id":"mandate-period", …},{"id":"mandate-lifetime", …},{"id":"vault-daily", …},{"id":"free-buffer", …},
     {"id":"not-paused", …}]}

GET /workspaces/baseline/maximum
200 {"maximum":"25000000","checks":[…],"execution":"none","note":"The largest amount every signed limit, the free balance
     and the remaining windows allow right now. An authorisation ceiling, not a guaranteed executable quote: …"}

GET /workspaces/baseline/quote?amount=12.5
200 {"allowed":true,"amountIn":"12500000","expectedOut":"11364149","bound":"11364152","gapPpm":0.263,
     "plan":{"hops":[{"venue":0,"label":"tUSD/tEUR · 0.30% · deep","tokenIn":"tUSD","tokenOut":"tEUR","amountIn":"…",
     "amountOut":"…"}, …],"prices":{"tUSD":"…","tEUR":"…","tETH":"…"},"alternatives":[{"policy":"certified", …},
     {"policy":"direct-optimal","shortfallBps":…}, {"policy":"equal-split", …},{"policy":"single-venue", …}]},
     "source":{"provider":"QEDExecution.quoteBound and pool reserves on the local Anvil chain","instrument":"tUSD → tEUR
     over the five owner-approved constant-product venues","priceType":"indicative executable quote on current reserves
     (not a public market price)","block":"34","sourceTime":1795122651,"receivedAt":"…","freshness":"current block;
     rechecked at execution"},"execution":"none","notice":"Read-only indicative quote; live reserves, authorization
     and certificate are rechecked at execution."}
```

### Proposals and execution (WF-1, WF-3, WF-5)

| Method and path | Request | Success | Errors |
|---|---|---|---|
| `POST /workspaces/:workspaceId/proposals` | `{ kind, params }` (table below) | `201` `Proposal` with `terms`, `termsHash`, `allowed`, `checks` | `422 unsupported_proposal`, `422 invalid_params`, `422 invalid_amount`, `422 invalid_tool_input`, `422 unknown_attack`, `422 unknown_payee`, `422 zero_slack_refused`, `409 not_provisioned`, `409 no_mandate`, `409 no_policy`, `409 already_provisioned`, `409 policy_contract_wired`, `409 venue_set_changed`, `409 zk_optional_disabled`, `409 authority_release_rule` (a `grant` where C12 is the release's rule), `429 quota_exceeded` |
| `GET /workspaces/:workspaceId/proposals/:id` | none | `200` `Proposal` (`status`: `open`, `used`, `expired`, `cancelled`) | `404 unknown_proposal` |
| `POST /workspaces/:workspaceId/proposals/:id/cancel` | `{}` | `200` `Proposal` | `404 unknown_proposal` |
| `POST /workspaces/:workspaceId/proposals/:id/execute` | `{ approval }` and header `Idempotency-Key` | `202` `Accepted` and `Location: /jobs/<id>` | `400 idempotency_key_required`, `422 approval_required`, `422 approval_malformed`, `409 approval_terms_mismatch` (both hashes in `details`), `409 approval_from_future`, `409 approval_predates_terms`, `409 approval_after_expiry`, `409 approval_replayed`, `409 proposal_used` (`details.jobId`), `409 proposal_expired`, `409 proposal_cancelled`, `409 proposal_stale`, `409 idempotency_conflict`, `429 busy` (16 operations already accepted and unfinished), `429 quota_exceeded` |

| `kind` | `params` | What the terms contain | What the job does |
|---|---|---|---|
| `provision` | none | the two owner actions (`QEDVault.setAgent`, `QEDExecution.setVenues`), roles, contracts, caps, the five venues | sends the two transactions; skips one that is already done |
| `mandate` | `maxPerPayment` (1 to 100 tUSD); optional `maxPerPeriod`, `maxTotal`, `validDays` (1 to 30) | all thirteen mandate fields, the mandate hash, and `supersedes` with the `revokeMandate` action when a mandate is active | revokes the previous mandate **on-chain**, then signs the new one (EIP-712); no transaction for the first mandate |
| `convert` | `amount` | vault, tokens, recipient, raw amount, nonce, and `message`: the exact EIP-191 text the owner key signs | the eight steps: interpret, limits, owner signature, co-signer, route and proof, broadcast, receipt, reconciliation |
| `attack` | `kind` (one of six, see `GET /workspaces/:workspaceId/attacks`) | the genuine order the attack starts from, the expected error and the defending layer | co-signs the genuine order, alters it, mines it with a fixed gas limit; it must revert; balances are compared before and after |
| `policy` | `targetFree` (2 to 80 tEUR); optional `enforcement`: `"cosigner"` (default) or `"contract"`, and for `"contract"` `needSlackBps` (1 to 1000, default 10; **0 is refused**) | the policy fields, its sequence number, `message`: the exact EIP-191 policy text, `supersedes`, and for `"contract"` the owner actions `QEDTreasuryPolicy.setPolicy` and `QEDExecution.setOperator` | owner signs the text; the co-signer verifies that signature and from then on refuses every older policy; the previous policy is marked superseded |
| `policy-revoke` | none | `message`: the revocation text the owner signs; in contract mode the actions `QEDTreasuryPolicy.revoke` and `QEDExecution.setOperator(operator key)` | ends the policy; the co-signer refuses it from then on; ticks then fail with `no_policy` |
| `scenario` | `tool`, `parameters` (see `GET /workspaces/:workspaceId/scenarios`) | the tool, its normalised inputs and a one-line description | runs the release's own scenario with fresh contracts, tokens and roles; the main treasury is compared before and after |
| `pause` | none | the owner action `QEDVault.pause` and its effect | pauses the treasury vault; agent payments revert `VaultPaused`; due liabilities still settle; the worst-case figure becomes 0 |
| `guardian-pause` | none | the guardian's address and the `pause` call | the same pause, sent by the **guardian's** key; the guardian cannot resume (`NotOwner`) |
| `resume` | none | the owner action `QEDVault.unpause` | resumes; owner only |
| `revoke-mandate` | none | the active mandate's version and hash, the action `revokeMandate` | revokes it on-chain and signs nothing in its place: no mandate is active afterwards |
| `void-all` | none | the vault's current epoch and the action `bumpEpoch` | every mandate and certificate issued so far becomes void (`StaleEpoch`); sent only while the epoch is still the approved one |
| `rotate-key` | `role`: `"operator"`, `"guardian"` or `"cosigner"` | `from`, `to` and the owner actions (`setOperator` and `setAgent`; `setGuardian` twice; `setCosigner` twice) | registers the new key on both vaults; the old key stops working at once; the new key is used from then on and after a restart |
| `pay` | `payee`: `"CloudCo"` (a label from the owner's book; no address is accepted), `amount`; optional `dueInDays` (1 to 365) | payee address and label, raw amount, nonce, mandate version and hash, and `message`: the exact EIP-191 payment instruction the owner key signs | limits, owner signature, co-signer certificate (the release's eight payment checks), `QEDExecution.pay` sent by the operator key, receipt, reconciliation. With `dueInDays` nothing leaves the vault: the amount is ring-fenced for the payee as a liability and counts against the caps at once |
| `ring-fence` | `creditor`: `"CloudCo"`, `amount`, `dueInDays` (1 to 365) | creditor, raw amount, `dueAt` (unix seconds, fixed when the proposal is prepared), and the owner action `QEDVault.ringFence` | ring-fences free funds for the creditor. Irrevocable by the owner; the agent's caps do not move. Refused before sending when the amount exceeds the free balance |
| `withdraw` | `amount` | the owner's own address as `to`, raw amount, and the owner action `QEDVault.withdraw` | moves free funds to the owner's own account. Above the free balance it is refused before sending, naming both figures |
| `deposit` | `amount` | the owner's own address as `from`, raw amount, and the two owner actions `TestUSD.approve` (exactly the amount) and `QEDVault.deposit` | moves tUSD from the owner's own account into the vault. Refused before sending when that account holds less |
| `venues` | `venues`: one to five of the deployed pools by number (0 to 4), ascending, each once | the set named now (`current`), the set to be named with labels, pools and fees, and the owner action `QEDExecution.setVenues` | names the new set. Every order signed for the previous set is void (`VenueSetChanged`). While the set is not the five, `attack` proposals answer `409 venue_set_changed`. Naming the set that is already named sends nothing (`no-action`) |
| `grant` | `amount` (in the vault's asset). Only where C12 is the authority budget (R7 D7); elsewhere `409 authority_release_rule` | vault, raw amount, nonce, and `message`: the exact text `QED authority grant …` the owner's passkey signs for the owner account (ERC-1271 over its EIP-191 hash) | the owner signs; the co-signer checks the signature as the vault checks owner signatures and keeps the grant in its durable state. No money moves and no transaction is sent. The budget reports it as granted, never as earned; the same signed grant again adds nothing |

```text
POST /workspaces/baseline/proposals
> {"kind":"convert","params":{"amount":"10"}}
201 {"id":"3db5a429-…","kind":"convert","status":"open","allowed":true,"checks":[…eight rules…],
     "terms":{"kind":"convert","chainId":31337,"genesisId":"19d2e81a-…","vault":"0xF7C1…","tokenIn":"0x6Fdd…",
       "tokenOut":"0x9532…","recipient":"0xd5AB…","amount":"10","amountIn":"10000000","nonce":"rail-19d2e81a-1",
       "instruction":"Convert 10 tUSD to tEUR","mandateVersion":1,"mandateHash":"0x60d2…",
       "message":"QED owner instruction\nvault: 0xF7C1…\nconvert: 10000000 of 0x6Fdd…\ninto: 0x9532…\nfor: 0xd5AB…\nnonce: rail-19d2e81a-1"},
     "termsHash":"sha256:0842cbe79c8d84a71e3afd67d97e209e6b1d0278902d33a7fb74af3ab8cb22df",
     "summary":"Convert 10.00 tUSD into the euro reserve (tEUR), under mandate v1, with the co-signer's floor and the
     on-chain best-execution bound.","createdAt":"2026-11-19T21:10:51.575Z","expiresAt":"2026-11-19T21:20:51.575Z", …}

GET /workspaces/baseline/proposals/3db5a429-…
200 (the same object; "status" becomes "used" and "jobId" appears once it was executed)

POST /workspaces/baseline/proposals/3db5a429-…/execute        Idempotency-Key: example-key-0003
> {"approval":{"approvalId":"ap-example-3","docHash":"sha256:9f2c…","termsHash":"sha256:0842cbe7…","confirmedAt":
   "2026-11-19T21:10:51.576Z","method":"passkey"}}
202 {"jobId":"8c597194-…","kind":"convert","status":"accepted","duplicate":false}
    (sent again with the same key and body: 202 with the same jobId and "duplicate":true)

POST /workspaces/baseline/proposals/ec075321-…/cancel
> {}
200 {"id":"ec075321-…","kind":"convert","status":"cancelled", …}
```

### Main treasury besides conversion: payments, liabilities, withdrawal, deposit, venue set

The five proposal kinds `pay`, `ring-fence`, `withdraw`, `deposit` and `venues` go through `POST /workspaces/:workspaceId/proposals` and
`POST /workspaces/:workspaceId/proposals/:id/execute` like every other. Two routes are specific to liabilities, and one reads what a payment may be without preparing anything:

| Method and path | Request | Success | Errors |
|---|---|---|---|
| `GET /workspaces/:workspaceId/liabilities` | none | `200 { liabilities: LiabilityView[] }`: every ring-fenced obligation of the treasury vault, oldest first, with `creditor`, `amount`, `dueAt`, `status` (`open`, `settled`, `released`), `due`, and `createdByRole` (`owner` for a ring-fence, `agent` for a forward payment) | `503` |
| `GET /workspaces/:workspaceId/payments/limits` | `?amount=` (optional; without it the smallest unit is checked, which shows what is left) | `200` `PaymentLimits`: the limit check for a payment from the treasury, as a read. The conversion limits plus the co-signer's C12, each with usage and what remains: the release's earned-autonomy rule (`earned-autonomy`) in the baseline-parity workspace, the authority budget of R7 D7 (`authority-budget`) in a workspace; `maximum`, the largest payment every rule allows now; `earned { limit, used, remaining }`; `mandate`; and in a workspace `authority`, the co-signer's own budget (`AuthorityView`: base, grants, granted, earned, used and what used it, held, reserved, available, the reference bands, one sentence adding them up, and what the figures do not say). Nothing is prepared, signed or sent, no proposal is created and none of the rail's budget is used | `422 invalid_amount` |
| `POST /workspaces/:workspaceId/liabilities/:id/settle` | `{}` and header `Idempotency-Key`. **No approval**: the contract lets anyone pay a due liability to its creditor, also while the vault is paused | `202` `Accepted`. The job's outcome is `executed` (paid to the creditor), `refused` (not due yet; nothing sent) or `no-action` (already settled or released) | `404 unknown_liability`, `422 invalid_params`, `400 idempotency_key_required`, `409 idempotency_conflict`, `429 busy`, `429 quota_exceeded` |

```text
POST /workspaces/baseline/proposals
> {"kind":"pay","params":{"payee":"CloudCo","amount":"3.123456"}}
201 {"id":"73ca92e0-…","kind":"pay","status":"open","allowed":true,
     "terms":{"kind":"pay","chainId":31337,"genesisId":"e0679de8-…","vault":"0xF7C1…","token":"0x6Fdd…","payee":"0x7A66…",
       "payeeLabel":"CloudCo","amount":"3.123456","amountRaw":"3123456","dueInDays":0,"nonce":"rail-e0679de8-1",
       "instruction":"Pay CloudCo 3.123456 tUSD","mandateVersion":1,"mandateHash":"0xad64…",
       "message":"QED owner instruction\nvault: 0xF7C1…\npay: 0x7A66…\namount: 3123456\ndueInDays: 0\nnonce: rail-e0679de8-1",
       "via":"QEDExecution.pay, which forwards to QEDVault.executePayment"},
     "termsHash":"sha256:bc35d19e…","summary":"Pay 3.123456 tUSD to CloudCo from the treasury, under mandate v1 and a
     co-signer certificate.","checks":[ …the eight rules of GET /limits, and:
       {"id":"earned-autonomy","rule":"Earned autonomy (co-signer check C12): everything the vault has paid out, conversions
        included, plus this payment, stays within 10 tUSD + 50% of verified escrow revenue","limit":"10000000","used":"0",
        "remaining":"10000000","pass":true,"detail":"This treasury has no escrow, so its verified revenue is 0 and the
        allowance is 10 tUSD in total."}], …}
    executed like any proposal; the finished job has six steps (mandate, owner, cosigner, submit, receipt, reconcile) and
    "result":{"outcome":"executed","summary":"Paid 3.123456 tUSD to CloudCo; treasury now 96.876544 tUSD.","tx":{"hash":
      "0x3b65…","status":"success","block":"35","gasUsed":"228771"},"evidence":{"payee":"0x7A66…","payeeLabel":"CloudCo",
      "amount":"3123456","dueInDays":0,"dueAt":"0","liabilityId":null,"cosignerChecks":8,"evidenceHash":"0x4a9c…"}}
> {"kind":"pay","params":{"payee":"CloudCo","amount":"4","dueInDays":7}}
    "result":{"outcome":"executed","summary":"Promised 4.00 tUSD to CloudCo: ring-fenced as liability #1, due
      2026-11-27T07:25:07.000Z. Free balance now 92.876544 tUSD.","evidence":{ …,"dueInDays":7,"dueAt":"1795764307",
      "liabilityId":"1","cosignerChecks":8, …}}
> {"kind":"pay","params":{"payee":"Mallory","amount":"1"}}
422 {"error":{"code":"unknown_payee","message":"Payments and ring-fenced funds go to an approved payee from the owner's
     book, named by its label. This treasury's book has: CloudCo. No address is accepted."}}

> {"kind":"ring-fence","params":{"creditor":"CloudCo","amount":"20","dueInDays":30}}
201 {"kind":"ring-fence","terms":{ …,"creditor":"0x7A66…","creditorLabel":"CloudCo","amount":"20","amountRaw":"20000000",
       "dueInDays":30,"dueAt":"1797751507","actions":[{"to":"0xF7C1…","contract":"QEDVault (treasury)","function":
       "ringFence","args":["0x7A66…","20000000","1797751507","0x997a…"]}]},"summary":"Ring-fence 20.00 tUSD of the
     treasury's free funds for CloudCo, due 2026-12-20T07:25:07.000Z (in 30 days). Irrevocable by the owner.","checks":
     [{"id":"free-balance","rule":"Free treasury balance: ring-fenced money is untouchable, even by the owner","limit":
     "92876544","used":null,"remaining":"92876544","pass":true}], …}
    "result":{"outcome":"executed","summary":"Owner ring-fenced 20.00 tUSD for CloudCo as liability #2; free balance now
      72.876544 tUSD.","tx":{…},"evidence":{"liabilityId":"2","creditor":"0x7A66…","amount":"20000000","dueAt":"1797751507"}}

GET /workspaces/baseline/liabilities
200 {"liabilities":[{"id":"1","creditor":"0x7A66…","creditorLabel":"CloudCo","amount":"4000000","dueAt":1795764307,
     "dueTime":"2026-11-27T07:25:07.000Z","status":"open","due":false,"createdBy":"0xd053…","createdByRole":"agent",
     "memo":"0x0c72…"},{"id":"2", …,"amount":"20000000","dueTime":"2026-12-20T07:25:07.000Z","status":"open","due":false,
     "createdBy":"0x81cB…","createdByRole":"owner","memo":"0xf8ae…"}]}

GET /workspaces/baseline/payments/limits?amount=2.876545
200 {"amount":"2876545","allowed":false,"checks":[ …the eight rules of GET /limits, all passing, and:
       {"id":"earned-autonomy", …,"limit":"10000000","used":"7123456","remaining":"2876544","pass":false, …}],
     "maximum":"2876544","earned":{"limit":"10000000","used":"7123456","remaining":"2876544"},"mandate":true,
     "execution":"none"}
    a read: no proposal is made and none of the rail's budget is used. The payment of 3.123456 and the promise of 4
    above count against the co-signer's allowance from the moment they are made; the owner's own ring-fence does
    not. Without ?amount= the smallest unit is checked ("allowed":true here), which shows what is left of each
    rule. These figures are the ones test/treasury-ops.test.ts asserts over HTTP for this state.

POST /workspaces/baseline/liabilities/1/settle        Idempotency-Key: 5c1e…
> {}
202 {"jobId":"6fd5e705-…","kind":"settle","status":"accepted","duplicate":false}
    then GET /jobs/<id>, before the due date:
    "result":{"outcome":"refused","summary":"Liability #1 (4.00 tUSD for CloudCo) is not due until
      2026-11-27T07:25:07.000Z; the vault would answer NotDueYet. Nothing was sent."}
    once it is due (steps liability, submit, receipt, reconcile): "outcome":"executed", and the summary names the
    amount paid to the creditor. A second request for the same liability under a new key: "outcome":"no-action".
POST /workspaces/baseline/liabilities/9/settle
404 {"error":{"code":"unknown_liability","message":"The treasury vault has no liability #9."}}

POST /workspaces/baseline/proposals
> {"kind":"withdraw","params":{"amount":"20"}}
201 {"kind":"withdraw","terms":{ …,"to":"0x81cB…","amount":"20","amountRaw":"20000000","actions":[{"to":"0xF7C1…",
       "contract":"QEDVault (treasury)","function":"withdraw","args":["0x81cB…","20000000"]}]},"summary":"Withdraw 20.00
     tUSD of the treasury's free funds to the owner's own account 0x81cB17fa….", …}
    "result":{"outcome":"executed","summary":"Owner withdrew 20.00 tUSD; treasury now 76.876544 tUSD (52.876544 free).", …}
> {"kind":"withdraw","params":{"amount":"500"}}      (allowed: false; if it is executed all the same)
    "result":{"outcome":"refused","summary":"Refused before sending: a withdrawal of 500.00 tUSD exceeds the free balance
      of 58.376544 tUSD. Ring-fenced money cannot be withdrawn, even by the owner; the vault would answer
      SolvencyViolation with both figures. Nothing was sent."}
> {"kind":"deposit","params":{"amount":"5.5"}}
201 {"kind":"deposit","terms":{ …,"from":"0x81cB…","amount":"5.5","amountRaw":"5500000","actions":[{"to":"0x6Fdd…",
       "contract":"TestUSD (tUSD)","function":"approve","args":["0xF7C1…","5500000"]},{"to":"0xF7C1…","contract":
       "QEDVault (treasury)","function":"deposit","args":["5500000"]}]}, …}
    "result":{"outcome":"executed","summary":"Owner deposited 5.50 tUSD; treasury now 82.376544 tUSD.", …}
> {"kind":"venues","params":{"venues":[0,1,4]}}
201 {"kind":"venues","terms":{ …,"current":[ …the five… ],"venues":[{"i":0,"label":"tUSD/tEUR · 0.30% · deep","pool":
       "0x4537…","feeBps":30},{"i":1, …},{"i":4,"label":"tUSD/tEUR · 1.00% · off-market","pool":"0x546d…","feeBps":100}],
       "actions":[{"to":"0xd053…","contract":"QEDExecution","function":"setVenues","args":[["0x4537…","0xf8fC…",
       "0x546d…"],[30,5,100]]}]}, …}
    "result":{"outcome":"executed","summary":"Owner named 3 venues: tUSD/tEUR · 0.30% · deep; tUSD/tEUR · 0.05% · thin;
      tUSD/tEUR · 1.00% · off-market. Earlier orders are void.","evidence":{"venueSetHash":"0xb63e…","venues":[0,1,4]}}
> {"kind":"attack","params":{"kind":"skim"}}      (while the named set is not the five)
409 {"error":{"code":"venue_set_changed","message":"The Security Lab's attacks are built on the five-venue market named
     at provisioning. The owner has named a different venue set; name the five again to run them.","details":{"named":
     [0,1,4]}}}
```

What these operations are and are not:

- **`pay` is the release's own payment path, unmodified**: the owner's EIP-191 instruction, the co-signer's
  `PolicyEngine.evaluate` (C1, C2, C3, C6, C9, C10, C11, C12), and `QEDExecution.pay`, which forwards to
  `QEDVault.executePayment`. The vault's agent is the execution module, so the operator key cannot call the vault
  directly. The payee book is fixed: CloudCo, the mandate's one external payee. The euro reserve is not a payee here,
  because tUSD sent to the reserve vault would be stranded; it is filled by conversion.
- **A liability's due date is a whole number of days ahead** (1 to 365). The rail keeps its chain on the wall clock, so a
  liability created today cannot be settled before tomorrow; the tests move an injected clock.
- **`settle` is sent by the operator key** because some funded key must send it; the contract accepts any sender and
  pays the creditor only. Nothing in the rail calls it on its own: the backend's scheduler asks, as for policy ticks.
- **The creditor's own actions (`release`, `assign`) are not rail operations**, and neither is the two-step transfer of
  ownership. The contract enforces them (the release's `QEDVault.t.sol` in the gate; `NotCreditor` in `treasury.test.ts`).
- **After an interruption none of these is run again.** The job is resolved by looking its journaled transaction up on
  the restored chain: found means done, not found means nothing moved (`recovery.test.ts`).

### Standing policy (WF-4)

| Method and path | Request | Success | Errors |
|---|---|---|---|
| `GET /workspaces/:workspaceId/policy` | `?limit=` (ticks, default 30) | `200 { policy: PolicyView or null, ticks: TickRecord[] }` newest tick first; each tick has its five `candidates` | `422 invalid_query` |
| `POST /workspaces/:workspaceId/policy/tick` | `{}` and header `Idempotency-Key` | `202` `Accepted`. The job's outcome is `executed` (a tranche was converted), `no-action` (target met, or the agent waits), or `refused` | `400 idempotency_key_required`, `409 idempotency_conflict`. The **job** fails with `no_policy` or `no_mandate` when nothing is signed |
| `POST /workspaces/:workspaceId/policy/run` | `{ maxTicks?: 1..12 (6), maxSeconds?: 1..600 (120) }` and `Idempotency-Key` | `202` `Accepted`. Runs ticks on the server until: the target is met, the agent waits, a tick is refused, a tick errors, or a limit is reached. `result.evidence = { ticks[], stopReason, targetMet, conversions }` | `422 invalid_params`, `400 idempotency_key_required` |

```text
POST /workspaces/baseline/proposals
> {"kind":"policy","params":{"targetFree":"30"}}
201 {"id":"7227700c-…","kind":"policy","status":"open","allowed":true,
     "terms":{"kind":"policy","chainId":31337,"sequence":1,"enforcement":"cosigner","needSlackBps":null,"supersedes":null,
       "policy":{"vault":"0xF7C1…","reserve":"0xd5AB…","tokenIn":"0x6Fdd…","tokenOut":"0x9532…","targetFree":"30000000",
                 "minTranche":"2000000","maxTranche":"25000000","maxImpactBps":150,"validUntil":"1797738861",
                 "nonce":"rail-policy-c637f337-1"},
       "message":"QED treasury policy\nvault: 0xF7C1…\nreserve: 0xd5AB…\nkeep free in reserve at least: 30000000 of 0x9532…\nconvert from: 0x6Fdd…\ntranche: 2000000 to 25000000\nmax impact bps: 150\nvalid until: 1797738861\nnonce: rail-policy-c637f337-1",
       "actions":[]},
     "termsHash":"sha256:099c3619…","summary":"Standing policy: keep ≥ 30.00 tEUR free in the euro reserve; tranches
     2.00–25.00 tUSD; ≤ 1.5% execution cost; valid 30 days. Enforced by the co-signer, which re-derives every tranche."}

POST /workspaces/baseline/policy/tick        Idempotency-Key: 5f0c…
> {}
202 {"jobId":"…","kind":"policy-tick","status":"accepted","duplicate":false}
    then GET /jobs/<id>: steps decide, cosigner, plan, submit, receipt, reconcile, and
    "result":{"outcome":"executed","summary":"Tick 1: converted 22.613317 tUSD → 20.250951 tEUR (limited by impact);
      reserve free 24.824288 tEUR.","tx":{"hash":"0x1ecc…","status":"success","block":"36","gasUsed":"444028"},
      "evidence":{"tick":1,"amountIn":"22613317","amountOut":"20250951","bound":"20250953","limitedBy":"impact",
      "candidates":{"need":null,"impact":"22613317","policyCap":"25000000","mandateCap":"25000000","freeFunds":"90000000"},
      "enforcement":"cosigner"}}

POST /workspaces/baseline/policy/run         Idempotency-Key: 9a41…
> {"maxTicks":6}
202 {"jobId":"…","kind":"policy-run","status":"accepted","duplicate":false}
    then GET /jobs/<id>:
    "result":{"outcome":"executed","summary":"Ran 2 ticks (1 conversion); stopped because the target is met. Reserve free
      30.00 tEUR of the 30.00 target.","evidence":{"ticks":[{"tick":2,"action":"convert","outcome":"executed","summary":
      "Tick 2: converted 5.881903 tUSD → 5.175712 tEUR (limited by need); reserve free 30.00 tEUR.","tx":{…}},
      {"tick":3,"action":"none","outcome":"no-action","summary":"Tick 3: target met (30.00 tEUR free); the agent stops."}],
      "stopReason":"the target is met","targetMet":true,"conversions":1}}

GET /workspaces/baseline/policy
200 {"policy":{"id":1,"status":"active","enforcement":"cosigner","targetFree":"30000000","minTranche":"2000000",
     "maxTranche":"25000000","maxImpactBps":150,"needSlackBps":null,"validUntil":1797738861,"nonce":"rail-policy-c637f337-1",
     "message":"QED treasury policy\n…","signedAt":"…","ticks":3,"reserveFree":"30000000","shortfall":"0","targetMet":true,
     "policyContract":null},
     "ticks":[{"n":3,"at":"…","jobId":"c3f1…","policyId":1,"action":"none","amountIn":"0","shortfall":"0","reserveFree":
     "30000000","limitedBy":null,"candidates":{"need":null,"impact":"0","policyCap":"25000000","mandateCap":"25000000",
     "freeFunds":"…"},"reason":"reserve is at or above its target: nothing to do","outcome":"no-action","summary":"…"},
     {"n":2,"action":"convert","amountIn":"5881903","limitedBy":"need", …}]}
```

Contract enforcement (`enforcement: "contract"`) makes the unmodified `QEDTreasuryPolicy` the execution module's
operator, so ticks go through `QEDTreasuryPolicy.convert`. While it is wired, `convert` and `attack` proposals are
refused with `409 policy_contract_wired` (the release's wiring removes direct trades, baseline W-12); `policy-revoke`
or a new `"cosigner"` policy unwires it.

### Scenarios (WF-6), scripted economies (WF-7 to WF-11), historical evidence (WF-14)

| Method and path | Request | Success | Errors |
|---|---|---|---|
| `GET /workspaces/:workspaceId/scenarios` | none | `200 { scenarios: ScenarioInfo[] }`: six tools with `bounds`, JSON `schema`, `available` | |
| `GET /workspaces/:workspaceId/economies` | none | `200 { economies[], running }`: four scripted runs, each labelled `SCRIPTED`, with `available` | |
| `POST /workspaces/:workspaceId/economies/run` | `{ scenario: "execution" or "economy" or "clearing" or "privacy", instruction?, impact?: 50 or 150 }` and `Idempotency-Key` | `202` `Accepted`; steps arrive as the script writes them (`GET /workspaces/:workspaceId/jobs/:id/events`) | `422 unsupported_scenario`, `422 invalid_instruction`, `422 escalation_refused`, `422 over_mandate`, `409 economy_running` (one at a time), `409 zk_optional_disabled` (`privacy`), `400 idempotency_key_required`. The **job** fails with `ports_in_use` or `economy_failed` |
| `GET /workspaces/:workspaceId/evidence` | none | `200` `HistoricalEvidence`: 161 transactions, 24 contracts; `label: "HISTORICAL"` on the index and on every row | |

Scenario inputs and bounds (the release's tool registry decides; one step outside any bound is `422 invalid_tool_input`):

| `tool` | `parameters` | Bounds |
|---|---|---|
| `portfolio` | `{ price, volatilities[] }` | price above 0 and at most 25 tUSD; 2 to 6 volatilities of 1 to 100 percent |
| `private_portfolio` | `{ price, volatilities[6] }` | exactly six volatilities; **off by default** (`409 zk_optional_disabled`, owner decision F-052) |
| `clearing` | `{ members[], obligations[{from,to,amount}] }` | 2 to 6 distinct labels; 1 to 16 debts, each at most 1,000 tUSD, between two different members |
| `payment` | `{ amount }` | at most 10 tUSD, to CloudCo |
| `liability` | `{ amount }` | at most 95 tUSD |
| `execution_bounty` | `{ amount }` | at most 25 tUSD |

```text
GET /workspaces/baseline/scenarios
200 {"scenarios":[{"tool":"portfolio","label":"Custom portfolio & paid-work escrow","available":true,"bounds":"Escrow price
     above 0 and at most 25 tUSD; 2 to 6 annual volatilities of 1 to 100 percent; zero correlations.","schema":{"type":
     "object","properties":{"price":{"type":"string","pattern":"^[0-9]+(\\.[0-9]{1,6})?$"},"volatilities":{"type":"array",
     "items":{"type":"number","minimum":1,"maximum":100},"minItems":2,"maxItems":6}},"required":["price","volatilities"],
     "additionalProperties":false}},{"tool":"private_portfolio","available":false,"unavailableReason":"The zero-knowledge
     scenario needs GPL-3.0 components … pending owner decision F-052. …"}, …4 more]}

POST /workspaces/baseline/proposals
> {"kind":"scenario","params":{"tool":"payment","parameters":{"amount":"3.123456"}}}
201 {"id":"0bbb9804-…","kind":"scenario","terms":{"kind":"scenario","tool":"payment","parameters":{"amount":"3.123456"},
     "description":"Delegated payment to CloudCo: 3.123456 tUSD.","isolation":"Fresh contracts, fresh valueless test tokens
     and fresh development roles on the local chain. The main treasury is not spent and its authority is unchanged."},
     "termsHash":"sha256:60c39f2a…","allowed":true, …}
    executed like any proposal; the finished job has 11 steps and
    "result":{"outcome":"executed","summary":"payment completed on local Anvil. Real receipts and reconciled balances are
      attached; main treasury balance is unchanged.","tx":{"hash":"0x6005…","status":"success","block":"43"},
      "evidence":{"vault":"0x7756…","cosignerChecks":[…8 checks…],"replay":{"status":"reverted","error":"IntentAlreadyUsed"},
      "vaultBalance":"96876544","creditorBalance":"3123456","tool":"payment","mainTreasuryUnchanged":true}}

GET /workspaces/baseline/economies
200 {"economies":[{"scenario":"execution","title":"The complete best-execution economy","label":"SCRIPTED","available":true,
     "takesInstruction":true,"bundledManifest":"evidence/ethereum-sepolia/execution/manifest.json","running":false},
     {"scenario":"economy", …},{"scenario":"clearing", …},{"scenario":"privacy","available":false, …}],"running":null}

POST /workspaces/baseline/economies/run      Idempotency-Key: 77b0…
> {"scenario":"clearing"}
202 {"jobId":"…","kind":"economy","status":"accepted","duplicate":false}
    then GET /jobs/<id>: 32 steps (a start step, then one per step of the script's manifest: id, title, ok / reverted / info) and
    "result":{"outcome":"executed","summary":"Certified multilateral clearing: completed with 31 steps on its own chain (30
      transactions, 7 mined as reverts as intended, 1 off-chain). Scripted, fixed scenario.","evidence":{"label":"SCRIPTED",
      "scenario":"clearing","network":"Anvil 31337 (a separate local chain for this run; disposable, valueless)","aiEngine":
      "offline-deterministic","steps":31,"transactions":30,"reverted":7,"final":{"gross":"200000000","cleared":"169000000",
      "greedyCleared":"162000000","settledWithTokens":"31000000","openObligations":"0", …},"comparedWithBundledManifest":
      {"manifest":"evidence/ethereum-sepolia/clearing/manifest.json","bundledSteps":31,"missingHere":[],"onlyHere":[]},
      "outputFolder":"…/data/rail/runs/<jobId>","lastLines":[…]}}

GET /workspaces/baseline/evidence
200 {"label":"HISTORICAL","network":"Ethereum Sepolia (chain 11155111)","explorer":"https://sepolia.etherscan.io",
     "note":"Historical: mined on the public Ethereum Sepolia testnet by the QED team on 19 and 20 October 2026, before
     this application existed. Not created by this session, not re-verified here …","transactions":[{"label":"HISTORICAL",
     "run":"Run 1 · authorised payments, escrow, attacks, honeypot","id":"D1","phase":"deploy","title":"Deploy TestUSD
     (valueless 6-dp test stablecoin)","hash":"0x209d…","status":"success","block":"…","gas":"…","error":null,"expect":
     "success"}, …160 more],"contracts":[{"label":"HISTORICAL","name":"TestUSD (main run)","address":"0x7adb…","match":
     "match"}, …23 more],"counts":{"transactions":161,"reverted":49,"contracts":24},"excluded":["evidence/ethereum-sepolia/
     honeypot.json (published private keys; owner decision F-060)","site/data.json (the same keys)"]}
```

Scripted economies run the release's own scripts on a **second, short-lived Anvil** (127.0.0.1:8547) with development
keys, the labelled offline parser and an explicit environment allowlist. They never touch the rail's own chain, so
they do not block it. `economy` also uses loopback ports 7701 to 7703 and takes about 95 seconds (it waits for real
deadlines). The `execution` run reproduces every step id of the bundled Run 4 manifest except the seven of Run 4b
(`XB1`–`XB4`, `XA1`–`XA3`), which the release produced with a separate script; on the rail that is the
`execution_bounty` scenario. The `economy` script writes a `honeypot.json` holding its *development* keys; the rail
deletes it from the run's output when the run ends.

### Language layer (guard, tool registry, amount lexer, offline parser, knowledge topics)

The backend can use it **in its own process** (no network hop, no loader flag, no build step) or over these routes.

```ts
import { screenMessage, validateToolCall, checkExplicitAmount, parseOffline, MODEL_TOOLS, CAPABILITIES,
         scanAmount, formatMicro, KNOWLEDGE, identifyKnowledgeTopic, TEXTS } from "../chain/language/index.ts";

const s = screenMessage(text);                 // (a) BEFORE any model call
if (s.refused) return reply(s.reply, s.engine);   //     fixed text, engine "deterministic security guard"
// … call the configured model with tools: MODEL_TOOLS …
const v = validateToolCall(call.name, call.input);          // (b) model output is untrusted until it passes here
const a = checkExplicitAmount(text, [call]);                //     the owner's own number governs
// (c) no model, or the call failed: the labelled deterministic parser, never counted as model-assisted
const { engine, guarded } = await parseOffline(text, chatContext, perPaymentCap);   // engine === "offline-deterministic"
```

The module is the release's own code loaded unmodified from `vendor/`. To load on plain Node it registers one
synchronous resolve hook (`node:module` `registerHooks`) that maps `./x.js` to `./x.ts` **only** for files inside
`vendor/agent/src/brain/`; no other import of the host process is touched. The guard is defence in depth, not the
binding control.

| Method and path | Request | Success | Errors |
|---|---|---|---|
| `GET /workspaces/:workspaceId/language/capabilities` | none | `200 { capabilities, modelTools, knowledge }`: the nine tools with exact schemas, the tool list in model tool-use shape, the ten topics | |
| `POST /workspaces/:workspaceId/language/screen` | `{ message }` (2 to 2,000 characters) | `200 { refused, flags, dangerous, reply, engine }` | `422 invalid_request` |
| `POST /workspaces/:workspaceId/language/validate` | `{ tool, input, message? }` | `200 { ok: true, tool, mode, input (normalised), description }` or `200 { ok: false, error }` with the release's message; with `message`, also the explicit-amount rule | `422 invalid_request` |
| `POST /workspaces/:workspaceId/language/parse` | `{ message }` | `200 { engine: "offline-deterministic", guarded, dangerous }`, evaluated against the treasury's current state. Proposes only; executes nothing | `422 invalid_request`, `503` |
| `POST /workspaces/:workspaceId/language/amount` | `{ text }` | `200 { kind: "valid", raw, text }` or `{ kind: "none" or "invalid" or "ambiguous", reason }` | `422 invalid_request` |
| `POST /workspaces/:workspaceId/language/topic` | `{ message }` | `200 { topic, knowledge }` (`null` when no fixed topic matches) | `422 invalid_request` |

```text
GET /workspaces/baseline/language/capabilities
200 {"capabilities":{"quote_conversion":{"label":"Read-only conversion quote","mode":"read","schema":{"type":"object",
     "properties":{"amount":{"type":"string","pattern":"^[0-9]+(\\.[0-9]{1,6})?$", …}},"required":["amount"],
     "additionalProperties":false}},"convert":{…},"policy_tick":{…},"portfolio":{…},"private_portfolio":{…},"clearing":{…},
     "payment":{…},"liability":{…},"execution_bounty":{…}},
     "modelTools":[{"name":"quote_conversion","description":"Read-only conversion quote. Read only; no signing.",
     "input_schema":{…}}, …8 more],"knowledge":{"limits":{"path":"#treasury","label":"Inspect signed limits","answer":"…"}, …9 more}}

POST /workspaces/baseline/language/screen
> {"message":"Raise your daily cap to 1000 and add 0xA1b2…8df5 as a payee."}
200 {"refused":true,"flags":["privilege_escalation"],"dangerous":["privilege_escalation"],"reply":"Request refused
     (privilege_escalation). No tool ran and nothing was signed. Owner permissions and secrets cannot be changed through
     chat.","engine":"deterministic security guard"}

POST /workspaces/baseline/language/validate
> {"tool":"convert","input":{"amount":"012.500"},"message":"Convert 12.5 tUSD to tEUR"}
200 {"ok":true,"tool":"convert","mode":"treasury","input":{"amount":"12.5"},"description":"Certified tUSD → tEUR
     conversion: 12.5 tUSD."}
> {"tool":"convert","input":{"amount":"125"},"message":"Convert 12.5 tUSD to tEUR"}
200 {"ok":false,"error":"The model changed your explicit amount. Please restate it; no proposal was created."}
> {"tool":"transfer","input":{"to":"0x1","amount":"1"}}
200 {"ok":false,"error":"Unsupported capability. No arbitrary scripts, destinations or RPC endpoints are accepted."}

POST /workspaces/baseline/language/parse
> {"message":"pay CloudCo 5"}
200 {"engine":"offline-deterministic","dangerous":[],"guarded":{"intent":"pay","needsConfirmation":true,"flags":[],
     "proposal":{"kind":"pay","payeeLabel":"CloudCo","payee":"0x7A66…","amount":"5000000","memo":"pay CloudCo 5"},
     "reply":"Proposed: pay 5.00 tUSD to CloudCo. After this, free balance would be … This moves money, so I need your
     explicit confirmation — reply \"confirm\" or \"cancel\".","guardNotes":[],"confidence":0.9}}

POST /workspaces/baseline/language/amount
> {"text":"Convert 22.5 tUSD to tEUR"}
200 {"kind":"valid","raw":"22500000","text":"22.5"}

POST /workspaces/baseline/language/topic
> {"message":"what is the blast radius if both keys are stolen?"}
200 {"topic":"security","knowledge":{"path":"#lab","label":"Open Security Lab","answer":"QED separates the agent, owner,
     independent co-signer and on-chain enforcement. …"}}
```

Note on `POST /workspaces/:workspaceId/language/parse`: a "pay" proposal from the parser is only a reading of the text; it creates nothing.
A payment from the main treasury is made with a `pay` proposal (payee by label, exact amount), a conversion with a
`convert` proposal. The release's nine-tool registry has no tool for a main-treasury payment (its `payment` tool is the
isolated scenario), so a model-proposed payment has no registry entry to be validated against; mapping the parser's
reading to a `pay` proposal is the backend's decision.

### Jobs, recovery and records (WF-12)

| Method and path | Request | Success | Errors |
|---|---|---|---|
| `GET /workspaces/:workspaceId/jobs/:id` | none | `200` `Job` with `steps[]`, `result`, `error`, `guidance` | `404 unknown_job` |
| `GET /workspaces/:workspaceId/jobs/:id/events` | none | `200 text/event-stream`: `event: step` per step (past ones first), then one `event: done` with the finished `Job` | `404 unknown_job` |
| `GET /workspaces/:workspaceId/jobs` | `?limit=` (default 30, max 200) | `200 { jobs: Job[] }` newest first | `422 invalid_query` |
| `GET /workspaces/:workspaceId/submissions/:key` | none | `200 { jobId, kind, status }` for the job this Idempotency-Key started | `404 unknown_submission` (nothing was started under this key) |
| `GET /workspaces/:workspaceId/receipts/:hash` | none | `200 { network, stored, chain }`: the stored receipt with decoded events or error, and the chain's own answer now | `422 invalid_hash`, `404 unknown_receipt` |
| `GET /workspaces/:workspaceId/movements` | `?fromBlock=`, `?toBlock=` (default: the workspace's deployment block to the latest), `?blocks=` (up to 64 heights, comma-separated) | `200 { network, head, range, finality, holders, tokens, movements, canonical }`: every Transfer of the workspace's two tokens into or out of its treasury vault, reserve vault or owner account, and the escrow's JobSettled for work it commissioned, ordered by block and log index, each with its block hash and time, confirmations, counterparty, the job that sent it (or null) and, for a conversion, each pool hop with the pool's fee and reserves before it; `canonical` is the hash the chain holds now at each height asked (null above the head); at most 2,000 movements, cut at a whole block (`range.complete` false) | `422 invalid_query`, `422 unsupported_read` (the baseline workspace) |
| `GET /workspaces/:workspaceId/decisions` | `?limit=` or `?jobId=` | `200 { decisions: DecisionRecord[] }` | `422 invalid_query` |
| `GET /workspaces/:workspaceId/decisions/verify` | none | `200 { ok, records, brokenAt, head }` | |

```text
GET /workspaces/baseline/jobs/8c597194-…
200 {"id":"8c597194-…","kind":"convert","status":"done","proposalId":"3db5a429-…","error":null,
     "steps":[{"seq":0,"key":"interpret","label":"AI interprets the instruction","status":"ok","detail":
       "offline-deterministic reads: convert 10.00 tUSD into the euro reserve (an approved payee from the owner's book).
       It proposes; it cannot sign.","data":{"engine":"offline-deterministic","intent":"pay","flags":[]},"at":"…"},
       {"seq":1,"key":"mandate", …},{"seq":2,"key":"owner", …},{"seq":3,"key":"cosigner", …},{"seq":4,"key":"plan", …},
       {"seq":5,"key":"submit","label":"Transaction broadcast", …},{"seq":6,"key":"receipt", …},
       {"seq":7,"key":"reconcile","label":"Balances reconciled","status":"ok", …}],
     "result":{"outcome":"executed","summary":"Converted 10.00 tUSD → 9.107516 tEUR; bound 9.107519; reserve now 9.107516
       tEUR.","tx":{"hash":"0xdbae…","status":"success","block":"35","gasUsed":"556627"},
       "evidence":{"amountIn":"10000000","amountOut":"9107516","bound":"9107519","gapPpm":0.329,"floor":"9016440",
       "tolerancePpm":1,"evidenceHash":"0x…"}}}

GET /workspaces/baseline/jobs/689afb9a-…/events
200 text/event-stream
    event: step
    data: {"seq":0,"key":"cosigner","label":"Genuine co-signed order","status":"ok", …}
    event: step
    data: {"seq":1,"key":"attack","label":"Malicious transaction built","status":"info", …}
    event: step
    data: {"seq":2,"key":"receipt","label":"Mined and reverted: OrderMismatch","status":"reverted", …}
    event: done
    data: {"id":"689afb9a-…","kind":"attack","status":"done","result":{"outcome":"reverted", …}}

GET /workspaces/baseline/jobs?limit=1
200 {"jobs":[{"id":"689afb9a-…","kind":"attack","status":"done", …}]}

GET /workspaces/baseline/submissions/example-key-0003
200 {"jobId":"8c597194-…","kind":"convert","status":"done"}

GET /workspaces/baseline/receipts/0x1c89a679c0feefd319eff5219a33ed9e4947cd90d2362920d6358d287763b376
200 {"network":"Local Anvil chain 31337 · …","stored":{"hash":"0x1c89…","jobId":"689afb9a-…","status":"reverted",
     "block":"36","gasUsed":"61910","from":"0x8b2F…","to":"0xd053…","error":"OrderMismatch","errorArgs":["0x8dde…",
     "0x4a03…"],"events":[],"at":"…"},"chain":{"status":"reverted","block":"36","gasUsed":"61910","logs":0}}

GET /workspaces/qed-1f0c…/movements?fromBlock=52&blocks=52
200 {"network":"eip155:31337","chainId":31337,"genesisId":"…","head":{"number":"58","hash":"0x9a1e…","timestamp":1795600000},
     "range":{"from":"52","to":"58","complete":true},"finality":{"kind":"confirmations","depth":2,"source":"R7 decision D6 …"},
     "holders":[{"role":"treasury","address":"0x5FbD…"},{"role":"reserve","address":"0xe7f1…"},{"role":"owner-account","address":"0x9fE4…"}],
     "tokens":[{"symbol":"tINR","address":"0xCf7E…","decimals":2},{"symbol":"tUSD","address":"0x5FC8…","decimals":6}],
     "movements":[{"txHash":"0x3c1d…","logIndex":1,"blockNumber":"52","blockHash":"0x77ab…","blockTimestamp":1795599990,
       "confirmations":7,"kind":"transfer","token":"0xCf7E…","symbol":"tINR","decimals":2,"amount":"350","from":"0x5FbD…",
       "to":"0x1CBd…","fromRole":"treasury","toRole":null,"counterparty":{"address":"0x1CBd…","kind":"payee","label":"CloudCo"},
       "jobId":"5d0e…","escrow":null,"conversion":null}, …],
     "canonical":{"52":"0x77ab…"}}

GET /workspaces/baseline/decisions?limit=1
200 {"decisions":[{"n":5,"at":"…","kind":"cosigner-trade","jobId":"689afb9a-…","verdict":"APPROVED","clock":{…},
     "approval":{"approvalId":"ap-example-4", …},"termsHash":"sha256:…","record":{ …the co-signer's canonical record… },
     "evidenceHash":"0x…","prevHash":"…","hash":"…"}]}

GET /workspaces/baseline/decisions/verify
200 {"ok":true,"records":5,"brokenAt":null,"head":"0c9998cabf6716f31ba1417331d9d81f8bf0aaaa8ebe5610f5b9b0e3b070e0a9"}
```

## What is vendored, and how "unmodified" stays checkable

`vendor/` holds 537 files copied out of `~/qed-approved-release` in the release's own layout, so every file runs
as it is. `VENDORED.json` lists each with its source path and SHA-256.

```bash
node scripts/verify-vendored.mjs             # recorded hashes AND the release folder AND the release's own manifest
node scripts/verify-vendored.mjs --offline   # recorded hashes only
```

- **No vendored file is modified** (`"modified": []`). Nothing is ever written into `vendor/`: suites and scripted
  runs use a disposable copy (`scripts/assemble-tree.mjs`), and the service's working directory is the data folder.
- 189 of the 537 are fingerprinted runtime files of the release and equal its saved manifest (digest `e4b2f571…`).
  With the 11 of the optional tier, 200 of the release's 201 runtime files are covered byte for byte. The one left
  out is `evidence/ethereum-sepolia/honeypot.json` (published private keys; owner decision F-060). `site/data.json`
  is not copied either. The verifier compares against both key values and prints neither.
- Left out on purpose, each with its reason in `VENDORED.json`: the old Railway deploy script and its test, circuit
  setup artefacts, the libraries' own tests and docs, the rejected page design's tooling, saved logs.
- `vendor/agent/test/parity.test.ts` contains Foundry's well-known Anvil account #0 key (a public test value that a
  secret scanner will flag). `vendor/agent/src/abi/contracts.ts` embeds the bytecode of all fifteen contracts,
  including the Groth16 verifier compiled from GPL-3.0 source; the default rail never deploys it.
- The GPL-3.0 parts are a separate tier that is **not copied**: see `zk-optional/README.md`.

## First parity gate

`results/PARITY-GATE.md` has the full tables; raw output is under `results/gate/`. The release's own suites, run in a
disposable copy of `vendor/`, mirroring the eight labels of the release's `RUN_FULL_LOCAL_QA.sh`:

| Tier | Runtime | Result |
|---|---|---|
| default (no GPL-3.0 source or package) | Node v22.23.3, Anvil 1.7.1 (the release's QA runtime) | **268 / 268 passed** |
| default | Node v26.12.0, Anvil 1.7.1 (this app's runtime) | **268 / 268 passed** |
| full (default plus the optional GPL-3.0 tier, enabled on this machine for the run) | Node v22.23.3, Anvil 1.7.1 | **295 / 295 passed** (Solidity 147 / 147, engine tests 64 / 64, type check clean) |
| full | Node v26.12.0, Anvil 1.7.1 | **295 / 295 passed** |

Solidity with `SOLC_VERSION=0.8.26`: 136 / 136. Engine tests: 59 / 59, including the 32-case red-team corpus.
305 in the release = 268 run + 37 not run in this tier: 27 need the optional tier (11 Solidity, 5 prover, 7 workbench,
4 release-identity), 7 assert the old Railway deploy script, 3 start the release server on every network interface.
In the full tier only 10 are not run: the 7 and the 3 just named. No test was edited.

```bash
node scripts/parity-gate.mjs --tier default [--node ~/.nvm/versions/node/v22.23.3/bin/node]
node scripts/parity-report.mjs
```

## Findings this rail rests on (Anvil 1.7.1, probed 19 and 20 Nov 2026)

- **State survives a restart.** `anvil_dumpState` → hard kill → fresh Anvil → `anvil_loadState` preserves block
  number, block hash, timestamps, balances, nonces, transaction receipts and event logs; the next block is mined at
  wall time. The rail dumps after every job (temporary file, fsync, rename) and restores at start and after an Anvil
  crash. A store with records but no state file fails closed; nothing is redeployed over existing records.
- **Clock.** `evm_setNextBlockTimestamp` accepts a value equal to the latest block's and rejects a lower one. A burst
  of auto-mined transactions shares one timestamp. The release's replica idiom `max(wall, latest + 1)` before every
  transaction makes the chain run ahead (11 s after 12 transactions), so the rail uses `max(wall, latest)` and never
  enables that mode. `eth_call` at `latest` sees the latest block's time (stale when idle); at `pending` it sees the
  wall clock, so the rail reads time-dependent views at `pending` and mines nothing for a read.
- **Sleep.** A sleeping machine suspends the service and Anvil without restarting them. The rail compares wall and
  monotonic time between its own heartbeats (and before each transaction), realigns the chain after a gap and records
  the event (`GET /workspaces/:workspaceId/clock`, and a `clock-gap` decision record).

## Security notes

### Two advisories in the pinned lockfiles: disposition (20 Nov 2026)

Both were reported by the main session's scan (trivy). The advisory texts were not fetched here: the identifiers,
severities and fixed versions are the scan's. `npm audit --offline` answers "found 0 vulnerabilities" for this package,
which only means that it has no advisory data offline; it is not evidence either way. What is stated under
"Reachable" was checked on this machine, with the commands given.

**Decision for both: keep the pinned versions and record why. Neither vulnerable function is reachable in anything the
rail runs.** Both pins are the release's own (`vendor/package-lock.json`); tsx is the loader that runs every vendored
release file, here and in the parity gate, so changing it means running both parity gates again on both Node versions.
No fixed version of either package is in this machine's npm cache, so an upgrade also needs the package registry.

| | esbuild 0.23.1, GHSA-67mh-4wv8-2f99 (medium) | elliptic 6.6.1, CVE-2025-14505 (low) |
|---|---|---|
| What the advisory is about | esbuild's development server answers requests from any origin, so a web page can read what it serves | ECDSA signing in elliptic |
| Where it is | `package-lock.json`: only through tsx 4.19.2 (`npm ls esbuild`) | `zk-optional/package-lock.json` only: circomlibjs 0.1.7 → ethers 5.8.0 → `@ethersproject/signing-key` 5.8.0. The default package does not install it |
| Reachable? | **No. The development server is never started.** No file of the rail, its scripts, its tests, the vendored release or the optional tier imports esbuild. tsx's shipped code calls only `transform` and `transformSync`; it contains no `serve(`, no `context(` and no `--serve`. esbuild's server exists only behind `context().serve()`. On the running service, tsx's esbuild child is `esbuild --service=0.23.1 --ping` (a pipe to its parent), no esbuild process holds a listening socket, and the rail's process tree listens on its HTTP port and Anvil's port only | **No. Nothing signs with it.** With the tier off it is not installed. With the tier on, the release's prover imports only `buildPoseidon` from circomlibjs; circomlibjs uses ethers for `keccak256`, `toUtf8Bytes`, `hexlify` and `arrayify` and nowhere creates a wallet or a signing key; no file of the rail or of the release imports ethers or elliptic. Every signature on the rail (owner, operator, co-signer, guardian) is made by viem. elliptic's `EC.prototype.sign` is loaded with ethers and never called |
| How to re-check | `grep -rnE "from ['\"]esbuild['\"]" rail scripts test language serve.ts vendor zk-optional/vendor` (no line); `grep -rlE "\.serve\(\|\.context\(\|--serve" node_modules/tsx/dist` (no file); `lsof -nP -iTCP -sTCP:LISTEN` while the service runs | `ls node_modules \| grep -ci "elliptic\|ethers"` (0); `grep -rnE "SigningKey\|signDigest\|Wallet\|signMessage" zk-optional/node_modules/circomlibjs/src` (no line); `grep -rn "circomlibjs" zk-optional/vendor` (one import, `buildPoseidon`) |
| What would change this | Any code that calls esbuild's `context()` or `serve()`, or a tsx version that does. A tsx upgrade is due in any case when Node removes `module.register` (the `DEP0205` notice); take a release that depends on esbuild 0.25.0 or later then, and re-run both parity gates | Any use of ethers 5 for signing in the optional tier, or a decision to ship the tier (owner decision F-052). Then add an `overrides` entry for a fixed elliptic once one is published (the release already does this for `ws`), or replace circomlibjs with a Poseidon implementation that does not bring ethers 5 |

### What else a reviewer should know

- **The co-signer's deny list (F-033; R13 audit P7).** Check C11 refuses a payee on the deny list in force: the folder's
  own `rail/denylist.json` when one was set, else the built-in test entry (the derived `host:denylisted` address,
  labelled "not a sanctions list"). Each list states its `source` and `asOf` date; a change is made with
  `node --import tsx rail/denylist.ts set <file.json> --by "<who>"` while the service is stopped, is recorded first in
  `rail/denylist-history.jsonl` (each record carries the SHA-256 of the one before; `rail/denylist.ts verify` checks the
  chain) and takes effect at the next start (`test/denylist.test.ts`). No sanctions list is loaded: that is the owner's
  decision.
- **Keys (multi-tenant).** Every key the host holds (its deployer, which mints the test tokens, the shared test payee
  CloudCo and the test deny-listed address; per workspace a deployer, an agent, a guardian and a relayer key) is
  derived with HKDF-SHA256 from `rail/master.key`, 32 random bytes created once with mode 600; none is derivable from
  a public string, and none is a signer of any owner account (`test/workspaces.test.ts`). The co-signer process keeps
  its own random key per workspace in `cosigner.key`, which the rail never reads. **Owners are passkey accounts**: the
  service holds no key that can satisfy one; it relays what the passkeys signed. A workspace's deployer key is the
  temporary owner of its empty vault set during creation only (decision D-B as amended on 22 Nov 2026, taken by the R7
  orchestrator: `docs/r7/00-ARCHITECTURE-DECISIONS.md`), and
  can do nothing on any of its contracts after the account accepted ownership.
- **Keys (baseline-parity mode).** The release's development keys from public strings, the owner key included, held
  by this process and used only under an approval bound to the exact terms (RISK-040). That mode exists for the
  baseline parity tests only and refuses `POST /workspaces`.
- **Secret scanners will flag two vendored files**: `vendor/agent/test/parity.test.ts` holds Foundry's well-known
  Anvil account #0 key, and `vendor/agent/src/abi/contracts.ts` holds contract bytecode. Neither is a credential.
- **The service is loopback-only** with one bearer token (mode 600), no CORS, a loopback `Host` check, a 16 KB body
  limit and its own request budget (`GET /workspaces/:workspaceId/quota`). It has one client and no per-user authorisation of its own.

## What is verified, and what is not

Verified means: a test in `test/` ran it on a real local Anvil chain with the release's unmodified contracts and passed
(`npm test`; counts are in `PARITY.md`, which names the test for every row it calls Verified). The suite is 27 test
files and 113 tests: the 74 written before R7, adapted where the interface changed, and 39 for R7 (`workspaces.test.ts`
8, `owner-account-wiring.test.ts` 3, `workspaces-http.test.ts` 2, `cosigner-fork.test.ts` 2, `hazards.test.ts` 1,
`anvil-cors.test.ts` 1; for decision D7 `authority.test.ts` 9, `authority-ledger.test.ts` 7, `authority-rail.test.ts`
6). 2 of them are skipped where the optional tier is not installed. Each rail under test has its own data folder and its own ports (HTTP 15176 to
15195, Anvil 18551 to 18761, a scripted economy's Anvil 500 above its rail's; ephemeral chains on ports the operating
system hands out; the `economy` script also binds 7701 to 7703). None of them is a port of a normally started rail
(5176, 8546, 8547).

| Verified | Test |
|---|---|
| R7 provisioning: the vault set is configured by the workspace's deployer key while it holds nothing; the passkey account accepts it; nothing arrives before; afterwards that key, and every other key the service holds, is refused by every owner function of the vaults, the execution module and the policy contract | `workspaces.test.ts` |
| R7 owner actions need a valid passkey assertion, checked on chain before anything is stored: missing, a non-member, an unknown key, another origin or relying party, no user verification, a registration ceremony, another challenge, a tampered signature, a replayed signature for an older nonce: each refused and recorded; no key the service holds can sign as the owner (ERC-1271) or is a signer | `workspaces.test.ts` |
| R7 two workspaces cannot read or move each other's funds (proposals, jobs, submissions, receipts, decisions of one are not found in the other; one's passkey cannot sign for the other; a withdrawal moves only the workspace's own funds); one paused or depleted while the other converts, deposits and withdraws; both intact after a restart | `workspaces.test.ts`, `workspaces-http.test.ts` |
| R7 guarded calls never run through execute (`GuardedCall`); a rotation is scheduled, listed, cancelled by one member, refused before the delay and applied after it; the account's guards are exactly chain/accounts' `releaseGuards` | `workspaces.test.ts`, `owner-account-wiring.test.ts` |
| R7 hazards: an attack and a time-moving scenario of one workspace run on ephemeral chains while another workspace transacts; the other's balances and jobs, and the shared chain's block times (never ahead, never back, no jump), are unaffected; the ephemeral chains are stopped and deleted | `hazards.test.ts` |
| R7 co-signer fork (D-A): exactly the generator's output from the unmodified vendored engine; for an ordinary-key owner on tUSD it decides identically to the release's engine across 25 check scenarios and 60 seeded random requests; for a passkey owner it verifies C1 and C3 by ERC-1271 where the release's engine throws | `cosigner-fork.test.ts`, `workspaces.test.ts` |
| R7 D7, the rule: the TypeScript port answers all 400 of the Python reference's cross-implementation sequences (4,558 events, 1,248 refused) exactly, event by event; round trips, self-payments, self-dealt escrow and a linked second workspace do not raise the budget, an unlinked one does (F1b, which is why P must list it), rounding to nearest leaks (F5) and outward rounding does not; over 3,000 seeded sequences (180,000 events) the budget rises only by credits, reversals and grants, and every other oracle holds; the same generator catches a rule that does not floor conversion costs and one that credits a client in P | `authority.test.ts` |
| R7 D7, the chain's events: payments to others consume, payments to C nothing; a conversion only its realised cost from its BestExecution (output outside C or no execution found: a payment of the input; an output with no reference: worth nothing); the agent's forward payment is a hold, the owner's own ring-fence is not counted; escrow earnings only from clients outside P, in tINR, after two confirmations; grants as granted; reservations dropped when used, expired or voided | `authority-ledger.test.ts` |
| R7 D7 in passkey workspaces on a local chain: after a 10 tINR conversion (realised cost 0.06 tINR, recomputed from the chain's event) a 1 tINR payment executes; a payment and a conversion beyond the budget are refused with C12 named, nothing sent, and the co-signer's own refusal record hashes to its evidence hash; the preview equals the co-signer's figures; an owner grant by passkey adds as granted, a non-member's or an ordinary key's is refused, the same grant again adds nothing; an outside client's escrow job adds half its price after two confirmations, while the workspace's own account, its agent key and a workspace sharing the passkey add nothing; an unsent certificate reserves its worst case until the owner voids it, and of two payment certificates asked for at once that each fit alone exactly one is signed (both are, with the co-signer's one-at-a-time admission switched off); a market pushed outside the fixed band is refused by C12 alone; with authority "release" C12 is the release's (after a conversion above 10 tINR no payment passes); over HTTP with the co-signer in its own process, the same figures before and after a restart | `authority-rail.test.ts`, `workspaces.test.ts`, `hazards.test.ts` |
| RISK-053, signers and recovery through the owner account's own functions on a local chain: a passkey that is not yet a member cannot add itself (`NotAMember`, nothing stored); the admin threshold adds one at once and it then signs alone; the same key twice is refused; raising thresholds is immediate and one passkey alone is then refused, lowering is scheduled, cancelled by one member, refused before the delay and applied after it; a removal is scheduled, the passkey it removes cannot cancel it, it is refused before the delay and applied after it, after which that passkey is refused; removing the last member is refused by the rail and, relayed directly, by the account itself (`InvalidThresholds`); a recovery key from a recovery code is added at once, another code's signature is refused with nothing sent, the right one adds the new passkey only after the recovery delay, and a member's cancel of a second recovery removes and spends its key; a key that was ever a signer of two workspaces keeps them linked in D7's principal set after it leaves one, and declared links are kept both ways and only added (two seeded mutations, dropping the history or the declared links, each make a test fail) | `signers.test.ts` |
| R7-054, earning through the release's ProofEscrow and MinVarianceVerifier between two passkey workspaces: the provider's passkey signs the quote (ERC-1271), the client funds from its own vault in one execute; a tampered quote, another client, another token, another verifier, a wrong problem and a used quote are refused before anything is sent; a counterfeit 1/N certificate is refused by the verifier with nothing signed; the certified delivery pays the provider's vault in the same transaction; the provider's budget gains ⌊price/2⌋ after two confirmations and not before; before the deadline only the provider can release the client, after it anyone refunds and a late delivery is refused; the same person's second workspace, a declared member in common, refund loops and a round trip between linked workspaces add nothing, while an outside client still does | `escrow-earn.test.ts` |
| R7 the owner-account build is used only when `chain/accounts/READY.json` declares it with a matching SHA-256; an undeclared, mismatched or other build is refused; the chain listens only on a port browsers refuse and is driven over an owner-only socket: a WebSocket and a rebinding request reach nothing, where a control Anvil started as before R13 is driven (G-C4, F-14) | `owner-account-wiring.test.ts`, `anvil-cors.test.ts` |
| R7 the multi-tenant HTTP contract on the real service with the co-signer in its own process: creation idempotent by id, refusals, 404 for an unknown workspace only after the token, cross-workspace identifiers not found, scheduled changes over HTTP, the host's budget (429 with `scope: "global"`), and a restart; a service killed in the middle of creating a workspace completes it at the same addresses on restart | `workspaces-http.test.ts` |
| R7 a standing policy signed by the passkey (ERC-1271) registers with the shared co-signer and its ticks reach the target; contract enforcement is scheduled behind the delay | `workspaces.test.ts` |
| Deployment from embedded bytecode; identical contract addresses, quotes, conversions, policy ticks and attack errors to the release's own `Sandbox` class; the exact figures of the release's production smoke log | `core.test.ts`, `policy.test.ts` |
| Approval binding: wrong hash, missing, malformed, future, predating, replayed; nothing signed on refusal; tampered stored terms caught at signing time | `core.test.ts` |
| Mandate: thirteen fields, EIP-712 parity with the contract, usage per limit; supersession revokes on-chain (`MandateIsRevoked`) | `core.test.ts` |
| Limits, maximum, quote with source and freshness; the eight conversion steps; reconciliation; refusal before signing | `core.test.ts` |
| Six attacks: mined reverts with the expected error, no balance change, certificate not consumed | `core.test.ts` |
| Standing policy: sign once, tick, five candidates, run until target with stop conditions, P2 and P0 refusals, durable co-signer state | `policy.test.ts` |
| Policy enforced by the unmodified `QEDTreasuryPolicy` on the live path: owner wiring, ticks through `convert`, and with both hot keys misused: `NotOperator`, `OverConversion`, `TrancheOutOfBounds`, `NoShortfall`, `ExecutionCostTooHigh`, `PolicyLapsed` as mined reverts; zero slack refused by the rail and shown, on the contract itself, to make the target unreachable (baseline W-11); the direct path lost while wired and restored on revoke (W-12) | `policy-contract.test.ts` |
| Co-signer as a separate process with its own random key: the rail holds only its address; a certificate forged with the derivable development key is rejected by the vault; it is restarted with the same key after it dies; rotation; restart. All service-level tests run in this mode | `cosigner-process.test.ts`, `service.test.ts`, `recovery.test.ts` |
| Pause, guardian pause (cannot resume), resume; worst-case figure 100 → 90 → 0 → 90; revoke one mandate; void all; rotation of operator, guardian and co-signer keys, surviving a restart | `admin.test.ts` |
| Five scenarios at their bounds with the release's expected results; main treasury unchanged; evidence index counts and labels | `scenarios.test.ts` |
| Three scripted economies end to end (`clearing` 169 of 200, `execution`, `economy` 47 steps and 19 reverts) and the release's validation rules | `economies.test.ts` |
| Clock: refusal with both times when the chain is ahead; sleep detected, realigned and recorded (injected clock, and a real process stopped with SIGSTOP); idle reads fresh without mining | `clock.test.ts`, `service.test.ts` |
| Restart: balances, mandate usage, receipts, event logs, history, proposals, jobs; Anvil crash restored; missing state file fails closed | `persistence.test.ts`, `service.test.ts` |
| Durable idempotency under a hard kill at three points: one execution at most, resolved by lookup, never re-sent | `recovery.test.ts` |
| Transport: token (mode 600, never printed), no CORS, loopback Host, body limit, sanitised errors, 503 until ready, step stream | `service.test.ts` |
| Language layer on plain Node with no loader: 25 of 25 corpus attacks refused, 7 of 7 benign allowed; registry, explicit-amount rule, lexer, topics, offline parser; the same over HTTP | `language.test.ts`, `service.test.ts` |
| Hash-chained, append-only decision records; every route documented; `types.ts` and `terms.ts` load on plain Node | `core.test.ts`, `contract.test.ts` |
| Proposal expiry and cancellation; a proposal of another chain refused; an injected reconciliation mismatch ends as `error` with `doNotRetry` and cannot be run again; an altered decision record is located by the chain check; edited vendored files keep the rail from starting | `integrity.test.ts` |
| Main treasury besides conversion: a payment of 3.123456 tUSD reaches only CloudCo under the mandate and a co-signer certificate, a replay is mined as `IntentAlreadyUsed`, an unlisted payee is refused by the rail, the co-signer and the vault; a forward payment and an owner ring-fence are funded at creation, untouchable by owner and agent, and settled to the creditor when due while paused, with no approval; withdrawal above the free balance refused with both figures; deposit; a later venue set voids an order signed before it (`VenueSetChanged`); the planned venues before provisioning; the same over HTTP with the co-signer in its own process | `treasury-ops.test.ts` |
| The same operations under a hard kill: a payment that was mined and saved is found by lookup, a withdrawal that was only broadcast is interrupted, neither is sent twice | `recovery.test.ts` |
| One failing case per co-signer check with a stored refusal record whose hash matches: C1, C2, C3 (instruction, policy, invoice), C4 to C12, C9b, T2 and P2 alone; T1 with T2, P1 with P2, P3 with P2, as the release's logic allows; a refusal inside a job stored under the owner's approval | `cosigner-checks.test.ts` |
| The rail's own budget: a rolling window per class, counted with the row it pays for, durable across a restart, `429 quota_exceeded` with `Retry-After`; a bounded writer queue (`429 busy`); a budget setting that is not a whole number refused at configuration | `quota.test.ts` |
| The parity register keeps its own rule: counts computed from its rows, every Verified row names a test, every named test exists | `contract.test.ts`, `scripts/parity-counts.mjs` |
| The optional zero-knowledge tier, **only when enabled**: the Groth16 scenario settles with commitments only; the `privacy` economy reproduces the bundled Run 3 step ids; without the flag the tier is not read | `zk.test.ts` (2 of its 3 tests are skipped by default) |

**Not verified** (stated so that nothing here is read as more than it is):

- `private_portfolio` and the `privacy` economy are refused by default. They work with the optional GPL-3.0 tier
  (`zk-optional/README.md`), which was enabled on this machine to test it; whether it belongs in the product is owner
  decision F-052.
- The co-signer's separation is a **process** boundary, not more: by default it runs as its own process with a random
  key it creates and keeps in a mode-600 file the rail never reads (`roles.cosignerIsolation: "separate-process"`), but
  both processes run as the same user on one machine, and it runs the same release solver as the maker. An
  independently written check, a separate user or machine, an HSM or a quorum do not exist (baseline W-08, L-01).
  With `QED_RAIL_COSIGNER=in-process` it is an object in the rail's process, as in the release's hosted app, and the
  state says so.
- Pause, revoke, void-all and rotation take effect at once. The baseline's proposal of a delay and out-of-band notice
  for protection-reducing changes (W-14) is **not implemented**.
- Nothing here was run against a public chain, the public QED URL or a real model; the Sepolia evidence is historical
  and was not re-verified (owner decision F-063). No user has tried any of it.
- Process separation, OS-level key isolation, an external price reference (baseline W-09) and an audit do not exist.
- In a passkey workspace: the owner account's guards make changes of the agent, co-signer, operator, venues, daily
  cap, ownership and policy wait for the account's delay (scheduled changes), but the rail sends no notification of a
  pending change to the members beyond `GET /workspaces/:workspaceId/scheduled`; the backend must show and announce
  them. The co-signer's C12 is the authority budget of R7 D7 (see "Amounts in a workspace"); what is NOT verified
  about it: its figures (B0 = 10 tINR kept from D-A, rate ½ from the release, a ±0.5% band) were chosen when it was
  built and are the owner's to confirm; the fixed
  reference band does not follow the market, and its re-centring is not built; the wallet shows the budget and offers grants
  (Vault, Pay and hold) since 22 Nov; no reorganisation was tested (a local chain has none; a credit the
  chain no longer holds is simply not counted); a client the rail has never seen may be a member's own address
  (A-ID: the budget says so, the chain cannot tell); the budget is a co-signer check, not a contract, so a co-signer
  key that is stolen bypasses it like every other check.
- The baseline-parity workspace's owner key is a development key held by the rail's process (RISK-040); every
  workspace created with `POST /workspaces` is owned by a passkey account instead.
- On the main treasury: the creditor's own `release` and `assign`, the two-step transfer of ownership and purchases
  against a vendor invoice are not rail operations. In the baseline-parity workspace payments stop at 10 tUSD of total
  outflow by the release's C12.
- The first parity gate below was not run again on 20 Nov 2026; its figures are the recorded output. Refusals that
  no test reaches, and the other open points, are listed in `PARITY.md` under "Not finished (exactly)".

## Tests of the rail itself

```bash
npm test             # node --import tsx --test, one file at a time, real local chains (about 5 minutes)
npm run typecheck    # tsc --noEmit
npm run lint:erasable
npm run verify:vendored -- --offline   # vendored files against their recorded hashes (without --offline it also reads the release folder)
node scripts/parity-counts.mjs         # the register's counts, and that every Verified row names an existing test
```
