# Security review R13 (24 November 2026)

An **agent-assisted review**, not an external professional audit and not a penetration test by an independent party.
The reviewer, the hunters and the validator are agents of one model family (Claude), working in one session; nobody
outside this work has read the code or these findings. What "confirmed" means here: the defect was reproduced on a
disposable local stack started for the purpose, with synthetic data and test credentials, and the exact requests and
answers are recorded. Everything else is a lead, labelled as such.

Owner's instruction: R13 section 7 (`docs/mandate/20261124-R13-financial-semantics-certificates-deployment-continuation.md`).

## 1. Scope

- **Reviewed revision:** `99dd3e4` (integration commit), branch `claude/r13-security`, worktree
  `.claude/worktrees/r13-security`. Fixes are on the same branch, after it.
- **In scope:** the API and engine (`apps/qed-demo/server/`, about 1.76 MB of TypeScript without tests), the on-chain
  wallet service (`apps/qed-demo/chain/rail/`, about 0.72 MB) and how the API reaches it, the interface's client code
  for DOM sinks, the dependency lockfiles, and the repository history for secrets.
- **Out of scope:** the Solidity contracts (Slither ran on 20 Nov), the guarantee checker's unbounded payment lead/lag in
  `shared/kernel` (another specialist is fixing it), `~/qed-approved-release`, the review build (ports 5174 to 5176,
  chain 8546) and its data, anything hosted or external.
- **Where tests ran:** only stacks this review started: API and engine on 127.0.0.1:10101 and 10102 with scratch
  databases in presentation mode (synthetic prices, so no market-data service was contacted), a model provider of
  "none", and one Anvil on 127.0.0.1:13401. Every process was stopped afterwards. No request left this computer except
  public-documentation reads of the two tools below and `npm audit` (package names and versions only).

## 2. Method

### 2.1 The two tools the owner named, evaluated before use (read 24 Nov 2026)

**Cloudflare Security Audit Skill** (https://github.com/cloudflare/security-audit-skill, MIT).
- *What it is:* written methodology for a coding agent: `SKILL.md` and fourteen reference files (reconnaissance,
  hunting, attack classes, web protocol and authentication, client side, resource exhaustion, data isolation, AI and
  LLM, supply chain, validation and reporting, and others), a report schema, and two zero-dependency Node validators
  (`validate-findings.cjs`, `validate-coverage-ledger.cjs`).
- *Instructions:* six phases (reconnaissance; coverage-led hunting by isolated sub-agents; independent validation, in
  which a fresh verifier tries to disprove each candidate; structured output with the verdicts confirmed,
  needs_validation and rejected; independent record verification; a report). Severity only for confirmed records.
  Defence-in-depth gaps and checklist deviations are not findings.
- *Dependencies and execution:* an agent with tool use and sub-agents; Node for the validators; target code may run
  only in an OS-enforced sandbox with no external network, an empty environment and resource limits.
- *Data access:* reads the target; writes its run outside the target (`~/security-audit-skill/<repo>/run-N`) by
  default. It names no external service and no model API of its own.
- *Decision:* **used as a methodology, applied directly.** Not installed (`npx skills add` would download it) and its
  validators not executed (code from an unvetted source). Adaptations, which are coverage gaps: findings are recorded
  in this file and in `evidence/r13-security/`, not in its `findings.json` schema; no coverage-critic pass and no
  fresh-agent re-verification of the final records were run (the owner's budget note); target code ran on loopback-only
  disposable stacks without an OS sandbox (presentation mode and a "none" model provider instead of enforced egress
  rules).

**Strix** (https://github.com/usestrix/strix, Apache-2.0; `strix-agent` 1.7.1; https://docs.strix.ai).
- *What it is:* autonomous AI agents that run a target, attack it and write proof-of-concept exploits, with an HTTP
  proxy (Caido), browser automation, a shell and a Python runtime inside a Docker sandbox
  (`ghcr.io/usestrix/strix-sandbox:1.4.1`, Kali-based: nmap, sqlmap, nuclei, ZAP, ffuf, trufflehog, gitleaks, trivy).
- *Requirements:* Docker; an LLM through LiteLLM (`STRIX_LLM`, `LLM_API_KEY`; a local endpoint is possible through
  `LLM_API_BASE`, and its documentation says models under about 70B parameters struggle); install by `curl | bash`
  from strix.ai or pip. Telemetry (PostHog, Scarf, OpenTelemetry) is **on by default** (`STRIX_TELEMETRY=0` turns it
  off); optional web-search keys; Strix Cloud uploads source code.
- *Decision:* **not run.** It sends code and responses to a model (an external model call, not authorised); Docker
  is not installed here and pulling a large third-party image and executing unvetted code is not authorised; no local
  model is installed (Ollama absent).
- *Coverage gap left by not running it:* no autonomous exploit generation, no automated scanners (nuclei templates,
  sqlmap, an active ZAP scan, ffuf fuzzing), no proxy-driven request mutation and no agent-driven browser attacks.
  *Done instead:* source review of every injection, command, path and outbound sink (hunter U5); hand-written dynamic
  checks against a disposable stack (`scripts/security.ts`, 119 checks); a browser-driven probe of the local chain
  (section 3, F-14); dependency and secret scans (section 2.3). *Not done by anything:* fuzzing of the HTTP surface,
  load testing, and SQL-injection automation (parameterised queries were verified by reading).

### 2.2 Coverage and validation

Reconnaissance produced an architecture brief (pipeline, roles, trust boundaries, known residual risks). Eight
read-only hunters, each with one unit, returned candidates with source traces: U1 authentication, passkeys, sessions
and approvals; U2 recovery, links, addresses and notices; U3 workspace authorisation, payments, escrow, goals; U4
instructions, runs, views and resource limits; U5 the model path, lab, evidence, market data and repository-wide
injection, SSRF and path sinks; U6 the API's side of the wallet service; U7 the wallet service itself and its chain;
U8 cryptography, keys, identifiers, logs and the dev server. Standards read against: OWASP ASVS 5.0 (the requirement
for each check is in `scripts/security.ts`) and the OWASP API Security Top 10 (2023): API1 object-level authorisation
(U3, U6), API2 authentication (U1, U2), API3 property-level authorisation (U3), API4 resource consumption (U4, U5),
API5 function-level authorisation (U3), API6 sensitive business flows (U3, U4), API7 SSRF (U5), API8 misconfiguration
(U7, U8), API9 inventory (U7), API10 unsafe consumption of APIs (U5, U6).

Every candidate was then validated by the parent, not by the hunter that found it: a check was written in
`scripts/security.ts` (group `r13-*`), run against the reviewed revision, seen to **fail**, the smallest fix made, and
the same check run again and seen to **pass**. Where a stack with the wallet service, a model or two vaults would be
needed and the budget did not allow it, the candidate stays a lead (section 4).

### 2.3 Scans

- `npm audit --package-lock-only`: the app, 0 vulnerabilities in 142 packages; the wallet service (`chain/`), 2 moderate:
  esbuild 0.23.1 (GHSA-67mh-4wv8-2f99, its development server's CORS; reachable only through esbuild's `serve`, which
  `tsx` does not use) and `tsx` through it. Trivy 0.76.2 with its cached database of 20 Nov, offline, agrees.
- `gitleaks git --redact` over the whole history (518 commits, 752 MB): 657 hits, every one reviewed by kind and
  sampled by line: public chain data in evidence files (addresses, hashes, "token" fields naming token contracts), the
  list of common passwords in `server/auth.ts`, a test key-encryption key, and two public front-end keys inside a scraped
  third-party web page (`experiments/r7/X9-calibration/data/terms/coinbase_market_data_terms.raw`). **No credential of
  QED's** was found.

## 3. Findings

Severity follows the skill's anchors, with the CVSS 3.1 reasoning given briefly; "within this build" means that the
money is paper and the tokens valueless, so the rating is of the control that fails, not of a loss.

| ID | Finding | Severity (reasoning) | Status | Check |
|---|---|---|---|---|
| F-01 | "Sign out everywhere" ended no session when the session acted in a business workspace: it used the workspace's id, so it answered 200 with `ended: 0` and even the asking session stayed signed in (`server/api.ts`) | Medium: a stolen session outlives the remedy the screen promises (AV:N/AC:L/PR:L/UI:R; I:L, C:L) | Fixed | R01 |
| F-02 | Ten wrong passwords sent together locked nothing: each read the failure count before its hash and wrote it back plus one (`server/auth.ts` `login`) | Medium: the lockout is defeated; only the per-address limit (30 in 15 min) remains, none with many addresses (AV:N/AC:L/PR:N; C:L, I:L) | Fixed | R02 |
| F-03 | A session opened with a password (a phished one) or with a sign-in-only passkey could end the owner's passkey sessions, one by one or all at once, as often as it liked, keeping the owner from every remedy that needs a session (`server/passkeys.ts`) | Medium (PR:L: needs the password or a cookie; A:H on the owner's access to remedies) | Fixed | R03 |
| F-04 | Every signed-out passkey "begin" wrote a challenge row that nothing ever removed (`server/passkeys.ts` `issueChallenge`) | Low: unbounded database growth at up to 1,500 requests a minute per address (AV:N/PR:N; A:L) | Fixed | R04 |
| F-05 | A reset link kept working after the owner removed (or replaced) the address it was sent to, and after a password change: the holder of the removed mailbox reset the password, ended every session of the owner and signed in (`server/recovery.ts`, `server/passkeys.ts`) | Medium; High for an account whose only key is its password (PR:N with control of one former mailbox; AC:H: a link asked for within 30 min before the removal; C:H, I:L) | Fixed | R05 |
| F-06 | A business's rule "from ₹X, N signatures" did not apply to standing instructions or their runs: one signature put in force an instruction able to move far more than X (`server/approvals.ts`, `server/programs.ts`, `server/runner.ts`) | Medium-High: full defeat of an explicit control by one member who may sign (PR:H; I:H) | Fixed | R06 |
| F-07 | A scheduled lowering of a business's signing policy, when it fell due, wrote back the whole policy of its day, silently undoing any raise made while it waited, with no delay and no notice (`server/passkeys.ts` `applyDueChanges`) | Medium (PR:H; I:H on the policy) | Fixed | R07 |
| F-08 | A revoked instruction came back into force with an amendment signed before the revocation (`server/programs.ts`; in a multi-signer business the last signature activates it by itself) | Medium (PR:H; I:H: authority "ended for good" returns) | Fixed | R08 |
| F-09 | A payment refunded after a dispute could be disputed again and was refunded again each time: money the payee never sent (`server/owner.ts`) | Low-Medium: paper books, but funds not conserved (PR:L; I:L) | Fixed | R09 |
| F-10 | The look-alike payee check compared every named payee with every other on the API's one thread, about 0.2 ms a pair: one bills preview naming 50 of 120 payees held every other request for 1 to 3 s, all 120 for 2 to 11 s, and on save or approval it held the database's write lock (the engine's limit is 8 s) (`server/lookalike.ts`, `server/programs.ts`, `server/owner.ts`) | Medium: any self-registered person stalls the service for everyone (AV:N/AC:L/PR:L; A:H) | Fixed | R10 |
| F-11 | An operator ("prepares, cannot sign") could resume an instruction the owner had paused and revoke or pause a protective (floor or exit) instruction with a passkey session (`server/api.ts`) | Medium (PR:L within a business; I:H on protection) | Fixed | R11 |
| F-12 | A malformed percent-encoding in a page path threw on the static side, before the throttle and the cross-site check: a 500 and a stack trace in the log per request (`server/api.ts` `serveStatic`) | Low (AV:N/PR:N; A:L, log flooding) | Fixed | R12 |
| F-13 | A certificate check at the endpoint's largest allowed size (5,000 bootstrap replications of a 1,176-scenario window) held the API's thread for 0.8 to 4.1 s; the viewer role is enough (`server/lab.ts`) | Medium (AV:N/AC:L/PR:L; A:H) | Fixed | R13 |
| F-14 | **Any web page can drive the local chain.** The rail starts Anvil with `--no-cors` and relies on it ("no web page can read its RPC", standards gap G-C4, `chain/test/anvil-cors.test.ts`), but CORS does not apply to WebSockets and Anvil checks neither Origin nor Host. Reproduced: a page served from `http://localhost:10199`, in Chrome 158, opened `ws://127.0.0.1:13401` (an Anvil started with the rail's exact flags), read the chain id and accounts and moved the chain's clock by one year; a plain HTTP request with a rebound Host (`rebind.evil.example`) and a foreign Origin got `eth_chainId`; and Anvil let a client send a transaction from an address holding code (impersonation), which is how an owner account would be acted for without its passkeys | High within this build (AV:N/AC:H: a page on a local origin, or a browser without Local Network Access gating; UI:R; S:C; I:H, A:H; the tokens are valueless). It voids SECURITY.md section 8's "owned by its own passkeys … the chain checks it again" for the local chain, and lets any page break every household's vault (clock skew, `anvil_setCode`) | **Confirmed, not fixed** | none (see below) |

**Why F-14 is not fixed here.** Anvil 1.7.1 has no option to turn off its HTTP or WebSocket listener, to check Origin
or Host, or to require a credential (`anvil --help`: only `--no-cors`, `--allow-origin`, `--host`, `--ipc`). The remedy
is a choice of architecture for the owner: (a) a chain client with Host and Origin allowlists on HTTP and WebSocket
(for example geth in developer mode with `--http.vhosts` and `--ws.origins`), keeping Anvil only for ephemeral test
chains; (b) running the chain where no browser can reach it (a container or VM network; Docker is not installed); or
(c) accepting it for the review build, with the rule that nothing else is browsed on that computer while it runs, and
dropping the G-C4 claim. Until then, also start Anvil with `--accounts 0` so the shared chain has no funded,
publicly known keys. `scripts/security.ts` has no check for it because it starts no wallet service; the reproduction
is three commands and a page (section 6), and a check belongs in `chain/test/anvil-cors.test.ts` once a remedy exists.

### What each fix does (smallest change; each check failed on `99dd3e4` and passes after)

- F-01 `server/api.ts`: `logoutEverywhere` and its audit use `r.personId`.
- F-02 `server/auth.ts` `login`: each try at a password is counted before the hash in one statement
  (`UPDATE … failed_logins + 1 … RETURNING`); a try beyond five is refused as the lock refuses it, unchecked.
- F-03 `server/passkeys.ts`: a weak session (password, or sign-in-only passkey) not freshly confirmed with a passkey
  ends only weak sessions; ending one passkey session from it is 401 `stepup_required`. A passkey session still ends
  everything, as do a password change and removal.
- F-04 `server/passkeys.ts` `issueChallenge`: challenges expired for more than an hour are deleted when a new one is issued.
- F-05 `endLinks` (`server/passkeys.ts`): unused password-reset and recovery links stop working when an email address is
  removed or replaced and when the password is changed or removed.
- F-06 `createApproval` takes the size to measure against the policy: an instruction's is the most its authority can
  move before it ends (`ceilingPaise`), so splitting into small runs does not lower it; a run's is its amount.
  *A semantic choice the owner may revisit* (the alternative, the largest single run, leaves the split open).
- F-07 a due lowering lapses (`cancelled_by = 'policy-changed'`, audited) when the policy is no longer the one it was
  worked out against; it can be asked for again.
- F-08 an ended instruction (revoked, completed, expired) takes no approval request and no activation; revoking
  discards its drafts and withdraws open requests to sign them.
- F-09 a payment with a refunded dispute cannot be disputed again (409 `already_refunded`); the engine's tick also
  refuses to refund twice.
- F-10 the edit distance is computed only near the diagonal and stops early (identical results for every value a caller
  compares; `server/lookalike.test.ts` checks 4,000 random pairs against the full table), skeletons are remembered,
  a workspace keeps at most 500 payees and one bills instruction names at most 50.
- F-11 resuming an instruction needs an approver; switching protection off (pause, revoke, cancel a run of a floor or
  exit instruction) needs an approver, and a weak session still needs a passkey confirmation as before.
- F-12 a malformed path is a 400.
- F-13 replications times window is at most 600,000 (the kernel's defaults, 2,000 x 120, are well inside); 20 checks a
  minute per person and 60 for everyone.
- Hardening, no finding: `GET /api/vault/:name` looks names up among its own keys only (`constructor` reached
  Object's prototype; no effect beyond a 500).

## 4. Leads (needs_validation: not reproduced; no severity)

| Lead | Claim (source trace by the hunter named) | What would confirm it |
|---|---|---|
| L-01 (U6) | One person can spend the wallet service's host-wide budgets (2,400 operations an hour, 16 economies, 60 vault set-ups) by creating business workspaces, each with its own per-workspace allowance, and block every household's vault operations | A rail with small quotas (`QED_RAIL_QUOTA_OPERATIONS=10`, global 20), two attacker workspaces ticking, then a victim's tick answered 429 `quota_exceeded` |
| L-02 (U6) | On a chain escrow, the provider keeps a release request open after the deadline (re-armed by cancelling its own approval), and the client's refund is refused 409 `already_pending` for as long as it does | Two vaults, a funded milestone past its deadline, the provider's release re-armed, the client's refund retried |
| L-03 (U6) | In a business, vault approvals require the chain's threshold, not a stricter workspace policy (raised signers, or the large-amount rule); SECURITY.md section 8 item 5 says the larger count is checked by QED | Policy raised to 2 after set-up; one approver signs and executes a withdrawal |
| L-04 (U6) | An escrow party sees the other party's job outcome text (it can carry the other vault's free balance) | A refused fund by the client, then `GET /api/earn/chain` as the provider |
| L-05 (U5) | The evidence "ask" case still shows another member's model-written proposal titles, payee names and refusal reasons in sections 3 and 8 and `related` (RISK-070's fix covered section 2 only) | A stack with `QED_AI_PROVIDER=scripted`, two members, one asks, the other reads `ask.<id>` |
| L-06 (U5) | Dismissing and drafting a model proposal are scoped to the workspace, not to the person who asked | As L-05, an operator acting on the other member's proposal id |
| L-07 (U5) | Model questions are limited per workspace and per person only: no installation-wide ceiling and no limit on concurrent model processes | A stub `claude` CLI that sleeps, 30 parallel questions from each of two accounts |
| L-08 (U5, U8) | The engine's `vault` summary (every vault's rail id, tick job ids, "paused by the owner") and `tick-error` / `escrow-error` events are emitted to every signed-in session, and quoted into other workspaces' evidence | Three households with vaults, one active policy and one paused; a third reads `/api/events` over a five-minute slot |
| L-09 (U4) | Rows one tenant adds cheaply (bills, money-in, drafts) slow every tenant and the engine's tick through scans without an index (`actions.program_id`, `bills.user_id`, `programs.user_id`); drafts store a 64 KB `proposalId` unchecked | Seed 10^4 to 10^5 rows, time another tenant's Home and the engine's `lastTickMs`, `EXPLAIN QUERY PLAN` |
| L-10 (U2, U3) | Any member with a passkey session, an operator or the member who made the change included, can acknowledge or dismiss a business's notices of a change to who can act, for every member | A vault recovery started by an approver in a business, its notice dismissed by that approver |
| L-11 (U2) | The backup recovery path does not refuse while an email recovery is open; two can be open and the email one can then not be finished | A password account with a confirmed email: start by link, then by saved code; finish by link → 409 `recovery_not_by_email` |
| L-12 (U1) | A weak session can stop a protective sale it may not cancel by re-requesting or cancelling the run's approval (`/api/runs/:id/approval`, `/api/approvals/:id/cancel` have no protective guard) | An exit instruction asking before each run, a run waiting; the owner's confirmation answered 409 `approval_withdrawn` |
| L-13 (U7) | The scripted-economy chain (8547) is started by the vendored release script without `--no-cors`, so Anvil's default `Access-Control-Allow-Origin: *` applies during a run | A preflight to the economy chain during `POST …/economies/run` |
| L-14 | The global throttle (1,500 requests a minute per address) lets any route costing more than about 40 ms of the API's thread saturate it; F-10 and F-13 removed the two measured worst cases, not the class | Time the heaviest reads (`/api/home` with a large book, `/api/market/history?hours=336`) under the throttle |

## 5. Hardening notes (not findings: no boundary failure shown)

The CSRF header is compared with `!==` (reachable only after the Origin check); the rail's token comparison returns
early on a length difference; a data key doubles as the HMAC key of its own check value; `data/rail` and the
co-signer's decision records are created with default modes (0755, 0644); `QED_KEK` stays in the environment of an API
that never loads it; the rail's 5xx messages reach the browser and can name key-folder paths; `security_events` has no
append-only trigger; `addMember` asks no consent and does not refuse a personal workspace; a weak session can change
notification preferences; `addAddress` sends confirmation messages to any address (a pumping risk once a provider
exists); `/api/health` says how many interface streams are open; the login's 429 `locked` answer tells a stranger that a
handle has a password after five tries (and lets them lock it, the usual lockout trade-off); `market.ts` reads a whole
upstream body before checking its size and follows redirects; the model CLI runs in a fixed temporary folder; sign-up
runs ten `scryptSync` calls on the event loop.

## 6. Checks added and how to reproduce

`scripts/security.ts` now runs in presentation mode (no outside service is contacted), refuses the review build's
ports, and refuses to start if its port is in use (before, it would have tested whatever answered there). It adds 13
checks, R01 to R13, in groups `r13-sessions`, `r13-links`, `r13-business`, `r13-instructions`, `r13-load`.
`QED_SECURITY_ONLY=<groups>` runs some groups only, for development.

- Before the fixes, on `99dd3e4`: 13 of 13 R checks failed
  (`evidence/r13-security/20261124-security-before-fix-99dd3e4.json`; R01 and R12 were corrected after a first run, in
  which R01's member was no longer in a business and R12's request was redirected, and failed again on the original
  `server/api.ts`: `…-before-fix-99dd3e4-business-load.json`).
- After the fixes: 119 of 119 (`evidence/r13-security/20261124-security-after-fix.json`).
- `QED_SECURITY_PORT=10101 node scripts/security.ts report.json` reproduces both (the interface must be built for S52).

F-14 by hand, on a disposable Anvil only (never the review build's 8546):
`anvil --host 127.0.0.1 --port 13401 --chain-id 31337 --no-cors --silent`, then
`curl -i -H 'Connection: Upgrade' -H 'Upgrade: websocket' -H 'Sec-WebSocket-Version: 13' -H 'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==' -H 'Origin: https://evil.example' -H 'Host: evil.example:13401' http://127.0.0.1:13401/`
(answer: `101 Switching Protocols`), and a page on another origin running
`new WebSocket('ws://127.0.0.1:13401')` with `eth_chainId`, `evm_increaseTime` and `evm_mine` (answered; the chain's
clock moved 31,536,029 s).

## 7. What remains

1. F-14, the owner's choice of remedy (section 3).
2. Leads L-01 to L-14: each needs the stack named in its row; L-03, L-05 and L-12 are the most likely to be real.
3. The tools' gaps (section 2.1): no Strix-style autonomous exploitation or scanners, no fuzzing, no load test, no
   coverage-critic pass and no fresh-agent re-verification of these records.
4. An independent review by people outside this work, which this is not.

## 8. Second pass (24 November 2026): F-14 fixed, the leads reproduced

Same method and limits as above, by the same model family; branch `claude/r13-security2` from `9266a1e`. Every stack was
disposable and loopback-only (API on 11550, a wallet service on 11552, Anvil on browser-refused ports or 11580-11599);
the review build was not used. The "before" runs are of `9266a1e` with only the new checks copied in.

**F-14 is fixed.** Options weighed: an in-process EVM (no library is installed; it would be a new dependency), another
node with Origin and Host checks (none installed; geth would be a new binary), and Anvil's `--ipc`. Anvil 1.7.1 cannot
drop its TCP listener (`--host ''` is refused: "invalid IP address syntax"), so no guard inside the wallet service can
cover it; the listener is instead put on a port that the Fetch standard blocks for fetch, navigation and WebSocket alike
(Chrome, and Node's own fetch, refuse it before connecting, under any host name), and the service drives Anvil only over
its IPC socket (folder 0700, socket 0600). `chain/rail/chain-socket.ts` answers the chain's address for the vendored
clients over that socket; a restarted chain keeps its port and socket. The same holds for the Security Lab's ephemeral
chains. The scripted economy's chain listens only on such a port too (a stand-in `anvil` on the release script's PATH
moves its port and adds `--no-cors` and the socket); because the release's services start with an allowlisted
environment, the run's own port is a guarded front instead (`startChainGuard`: no WebSocket upgrade, no request with an
Origin, Sec-Fetch-Site or Sec-Fetch-Dest header, Host only 127.0.0.1 or localhost on that port, JSON POST only). Check R14 starts a wallet service and probes its chain from Chrome 158 as section
6 did: before, a WebSocket from another local origin read and moved the clock (63,072,002 s for two connections) and a
rebinding request read `eth_chainId`; after, the only listener is 6665 and every attempt is refused (clock moved 1 s).
Remaining: non-browser local programs and other accounts on the computer still reach the listener (Anvil has no
credential); a browser launched with `--explicitly-allowed-ports` overriding the block; browsers other than Chrome were
not run (NOT VERIFIED).

| Lead | Result | Check (before → after) | Fix |
|---|---|---|---|
| L-01 | Confirmed: per-workspace budgets only, no per-person cap on businesses or vaults | R16 (5th vault set-up and 481st request allowed → refused) | `server/rail.ts` `quota`: 480 vault requests an hour per person over all workspaces; 4 vault set-ups a day and 10 vaults per person |
| L-02 | Confirmed: the client's refund refused `already_pending` while the provider's release request waited | R17 | `server/earn-chain.ts` `refundChainMilestone`: only a refund already waiting holds it off; the refund takes the waiting slot |
| L-03 | Confirmed: required signatures were the chain's threshold only | R18 (1 → 2; a pause stays 1) | `server/rail.ts` `proposeOnRail`: the larger of the chain's threshold and the workspace's count, except cancellations and calls that only stop something. The large-amount rule is not applied to vault requests: their amounts are test tokens with no rupee value |
| L-04 | Confirmed: the other party read a refused funding's words, with the client vault's free balance | R19 | `server/earn-chain.ts` `lastFor`: the outcome's words go only to the party whose step it was |
| L-05 | Confirmed: titles and refusal reasons in sections 3, 4 and 8 for a non-asker below admin | R22 | `server/evidence.ts` ask case: ids and SHA-256 instead, `related` filtered per question |
| L-06 | Confirmed: dismiss, draft and instruction-from-proposal by any member | R23 | `server/api.ts` `ownProposal` |
| L-07 | Confirmed: no installation-wide ceiling, no limit on model calls at once | R20 (3 of 3 answered at once → 2 and one refused) | `server/ai.ts`: `QED_ASK_ALL_HOURLY` (600) and `QED_ASK_CONCURRENT` (4), refused not queued |
| L-08 | Confirmed (reading): one `vault` line naming every workspace's vault, job and pause went to every session and into another workspace's evidence | R21 | per-workspace events (`server/rail.ts`), a count-only line for everyone (`server/engine.ts`), errors only to their own workspace (`server/escrow.ts`), readers scoped (`server/evidence.ts`, `server/judge.ts`). The engine's line is checked by reading only (NOT VERIFIED by a test) |
| L-09 | Confirmed: SCAN on `actions.program_id`, `bills.user_id`, `programs.user_id`; an id of any length stored as an origin | R24 | indexes as v8 part (k) (`server/schema.sql`); `ownProposal` checks the id |
| L-10 | Confirmed: an operator, and the member who started a recovery, cleared a business's notice for everyone | R25 | `server/api.ts` `mayClearWhoCanAct`: an owner or admin other than the one who made the change |
| L-11 | Confirmed: a backup recovery started beside an email one hid it (a link looked only at the newest), so the email one could not finish | R26 | `server/recovery.ts` `openEmailRequest`: a link shows and finishes the recovery started by email; a backup one beside it keeps its own reference. A first fix that refused the second recovery was withdrawn: it broke an owner's retry by saved codes (checks N25 to N28) |
| L-12 | Confirmed: a password session withdrew a protective run's request (asking again, or cancelling it); the owner's confirmation then got `approval_withdrawn` | R15 | `server/api.ts`: both routes take `guardProtective` when a request waits |
| L-13 | Confirmed (reading `vendor/agent/scripts/local.ts`: no `--no-cors`, an ordinary port) | `chain/test/economies.test.ts` (needs a wallet service running a release script, so not in `scripts/security.ts`) | `chain/rail/economies.ts` (see F-14) |
| L-14 | Not confirmed: `/api/home` and the 336-hour market history answered in under 5 ms on the test stack (report `measurements`); no large book was built | none | none |

Evidence (`evidence/r13-security/`): `20261124-security2-before-fix-9266a1e-leads.json` (R15 to R26 fail; its first R14
is set aside there: its probe page was QED's own, whose Content-Security-Policy stopped the WebSocket in the browser),
`20261124-security2-before-fix-9266a1e-chain.json` (R14 fails), `20261124-security2-after-fix.json` (the whole run),
`20261124-f14-chrome-probe.json` (the first manual probe), and the chain and Forge outputs named in the handover.

## 9. Hardening pass (24 November 2026): the ASVS 5.0 requirements still open, and the owner's decisions Q-048, Q-059, Q-062

Same model family and limits as sections 1 to 8, on branch `claude/r13-hardening` from integration `2d44be9`. Every stack
was disposable and loopback-only (security suite on 127.0.0.1:12550, its wallet service on 12552 and Anvil on 12581; the
browser spec on its own `QED_BROWSER_PORT` 12500); the review build was not used. The yardstick was OWASP ASVS 5.0.0, Level
2 where it applies and Level 3 for authentication, sessions, authorization and cryptography: all 145 requirements that were
Not met, Partly or Unknown were re-assessed (`docs/standards/ASVS-5.0-L3.md`, "Hardening pass of 24 November 2026").

**Result.** Met 112 → 181, Partly 92 → 58, Not met 52 → 17, Unknown 1 → 1 (N/A 88 unchanged). Of the 76 still open: 31 need
hosting or TLS, 12 the owner's decision, 2 an organisational process, and 31 are engineering this pass did not do, each
with what remains (none of those 31 is a confirmed vulnerability; most are documentation-by-schema, response shaping and
field encryption).

**What was built** (detail and file references: `SECURITY.md` section 8h): one transaction per changing request, with
rate-limit counts kept apart (brief item 2); a new passkey's 24-hour cool-off with removal at once by an older passkey
(item 3; RISK-068, Q-062); grants of authority to a member behind the 72-hour rule and narrowing at once, and resuming with a
fresh passkey only (item 4; Q-048, Q-059); a nonce Content-Security-Policy without `'unsafe-inline'` and a violation-report
endpoint; file kinds allowlisted and source maps never served; NIST AAL2 session lifetimes, a session cap, a new token's
predecessor ended at sign-in, a constant-time CSRF comparison, Clear-Site-Data at sign-out and an operator's session end;
context-specific password words and a lock notice; pre-v3 recovery codes put under scrypt (v8 part r); a cost-aware throttle
of the API's thread (lead L-14); a refusal log with an alert; outbound redirects refused; RFC 6266 download names; the
must-never-appear check for the two published testnet keys; the cryptographic inventory with discovery; the permission
table generated from the routes; a supply-chain check of both lockfiles.

**Checks added** (`scripts/security.ts`, group `r13-hardening`, and X03 beside R11): X01 the page's nonce policy in Chrome
(the sign-in page and 19 main screens drawn signed in with nothing blocked; a script without the nonce and an inline style
blocked and reported), X02 files never served, X03 resuming needs a fresh passkey, X04 grants wait and narrowing is at once,
X05 a new passkey's cool-off, X06 the refusal log, X07 a sign-in ends the presented session and sign-out clears, X08 a request
refused at its last write changes nothing. Existing checks adapted, with their intent kept: S14 (an API answer's policy is
now `default-src 'none'`; the page's is X01); members added through the route now wait for their grants (`addMembers`);
four passkeys a check adds are put past their cool-off by a labelled harness write where the check is about something else
(N15's, N22's, N47's and R15's); S54 keeps the expected `csp-violation` and `storage fault` lines apart and fails on anything
else.

**Runs.**
- Security suite, first run on the changed tree: 138 of 140; S54 failed on the storage-fault line X08 makes on purpose (then
  an unstructured console line) and X01 found no violation report within its wait: with both `report-uri` and `report-to`,
  Chrome sends through the Reporting API, batched up to a minute late. Fixed: the storage fault is a structured line kept
  apart, and the policy reports by `report-uri` only (`evidence/r13-security/20261124-hardening-security-first-run.json`).
- Second run: 140 of 140. X01 was then widened to draw the 19 main screens signed in; on the tree merged with the latest
  `claude/r11-meridian` (`4928e81`): **140 of 140**, X01 with 19 of 19 screens drawn, no violation
  The last small changes after it (members' pages told of a grant, the wallet service's safe fault words, a label) were
  run in the unit suite and the browser specs below, and the suite again on that tree (`0477bdb`): 140 of 140; and once
  more after merging the latest `claude/r11-meridian` (`054cd3f`, the chain's second pass) into the branch (`1046b60`):
  **140 of 140**, X01 with 19 of 19 screens drawn (`evidence/r13-security/20261124-hardening-security.json`). The unit suite
  on `1046b60`: 225 files, 2,684 tests, all passed.
- `browser/tests/csp.spec.ts` (new), run twice (the limit): first with `script-src 'nonce-…' 'strict-dynamic'`, every main
  screen passed with no violation; the second added a control that injects a script without the nonce, and it **ran**:
  under `'strict-dynamic'` Chrome lets any script element added by script run. The policy was changed to `script-src
  'nonce-…'` alone (a module's imports carry its nonce); the spec was not run a third time, so its final form is **NOT
  VERIFIED** by itself; X01 runs the same assertions on the final policy in Chrome and passes.
- Browser specs touched (system Chrome, one at a time, `QED_BROWSER_PORT=12500`, at most twice each): the grants and the
  cool-off change four existing journeys. `business-vault.spec.ts`: first run failed before the grants, at the vault's
  set-up, because this worktree had no owner-account build (`chain/accounts/out`; the wallet service answered 503
  `owner_account_unavailable`, which the new generic fault message hid: it is logged); built offline as the rules say
  (`SOLC_VERSION=0.8.38 FORGE_OFFLINE=1 sh scripts/deploy/build-owner-account.sh`, SHA-256 equal to READY.json's), the
  second run **passed**. `institutional.spec.ts`: **passed** (one run). `business.spec.ts`: both runs failed on two faults
  of this pass's own interface, each fixed: a member's role control was labelled "Role for …", which made the add form's
  "Role" label ambiguous (now "What … may do"), and a grant that fell due was not shown until a reload (the `workspace`
  event went to the workspace, not to its members' streams; now to each member). It was not run a third time: its final
  form is **NOT VERIFIED**; `business-vault.spec.ts` and `institutional.spec.ts` pass through the same steps.
  `vault-signers.spec.ts`: the first run timed out at the wallet's recovery offer, which lists only passkeys that may become
  signers and so needs the page read again after the third passkey's cool-off (the spec now reloads); the second run
  **passed**.
- Unit: the new files (`cool-off`, `grants`, `request-tx` with its seeded twin, `guard`, `session-hardening`, `headers`,
  `never-appear`, `crypto-inventory`, `permissions`, `supply-chain`) and the whole suite: counts in the hand-back.
- The request-transaction check was seen to fail with the dispatcher's transaction taken out (the floor saved without its
  audit entry: 50,100,000 against 50,000,000) and to pass with it. The X checks were written against the changed code and were
  **not** run against `2d44be9`, so that each fails before its change is NOT VERIFIED (their unit tests' seeded cases show
  the checks can fail).

**Owner decisions recorded as decided by the brief:** Q-048 (a grant of authority to a member is a loosening under the
72-hour rule; narrowing at once), Q-059 (resuming needs a fresh passkey confirmation, never a passkey session alone), Q-062
(the cool-off). Two readings this pass chose and the owner may revisit: a viewer is added at once (a viewer has no
authority to act), and the account's first passkey has no cool-off (no older passkey exists to remove it). The owner-account
contract was not changed: time-locking `withdraw`, `unpause` and `setGuardian` needs a redeploy and stays the owner's question.

**Not done, and why** (each with its ASVS requirement in the ASVS file): HSTS preload, a public certificate, OCSP stapling,
ECH, forward-secret suites, TLS and mutual authentication between services, a separate log store, memory encryption and an
HSM (need hosting); `__Host-` and `Secure` on the plain-HTTP local build (need TLS; the hosted profile has both); top-3,000
and breached-password lists (need a third-party corpus: the owner's decision); retiring the review-account password script
(the owner's review process); rotating the session token on a passkey step-up, per-route schemas, response shaping by
role, field encryption, an audit hash chain, a ReDoS analysis (engineering for a later pass).
