# QED security: what is defended, what was checked, what remains

For the local review build of 20 November 2026. Everything here concerns paper money on one computer. Nothing in
this file says the system is safe for real money; the last two sections say what that would take. **Section 8 (22
November 2026) supersedes the rows and items marked "Superseded" below; their original text is kept.**

Status words: **Checked** means a script or test in this repository ran it and the result is in the file named.
**Read** means the code was read by the orchestrating agent and nothing ran. **Not done** means not done.
No independent party has reviewed any of it. On 20 November an adversarial reviewer (an agent of the same model
family, read-only, briefed to find where this document claims more than the code does) refuted five rows of
section 3 as they then stood. Each was a real fault in the code, not only in the wording; each is fixed, tested and
marked in its row.

## 1. What is being protected

| Asset | Where it lives | What losing it would mean |
|---|---|---|
| The owner's authority: what may act, how much, until when | Signed instruction versions and approvals in the database; mandates on the local chain | Money moved that the owner never allowed |
| The record: ledger, receipts, decision records | Append-only ledger and a hash-chained receipt log in the database; a hashed decision log on the rail | No way to say what happened or to dispute it |
| The owner's password (Superseded 22 Nov 2026: see section 8) | A scrypt hash (N = 2^17) with a per-user salt | Someone else can sign as the owner |
| The session | A cookie (HttpOnly, SameSite=Strict); the server stores only a hash of the token | Someone else can read, and act up to what needs no password |
| The owner's position, sent to a model when Ask is used | Leaves this computer to the model provider, as a summary | Disclosure of balances, holdings, payees' names |
| The rail's bearer token and the local chain's development keys (Superseded 22 Nov 2026 for owners' vaults: see section 8) | `data/rail.token` (mode 600); keys derived from public strings | Nothing of value: test tokens on a local chain |

## 2. Who is trusted for what

1. **The owner** decides. (Superseded 22 Nov 2026 for how the owner confirms: every approval is a passkey signature
   over the document's hash, never a password; see section 8. The rest of this item stands.) Their decision is a signed document, bound by hash to exact terms, single use, to be
   confirmed within ten minutes and used within five more. A password is asked again for ₹10,000 or more in one
   action or in one day's password-free total, for anything that takes the worst case below the floor or dips into
   the bank reserve, for every instruction and vault operation, and for weakening a protection (a lower floor, a
   reserve that withstands less, any change that lowers what must stay in the bank). What the owner may do by hand
   that an instruction may not (go below the floor, take what must stay) is carried out only if the approved
   document said so: an approval given while the money was free does not cover it later.
2. **The engine** is the only thing that acts. Immediately before anything is sent it decides again from recorded
   state alone: the signed authority, the ledger, recorded prices and their age. No model output and nothing the
   interface claims is an input to that decision (`server/policy.ts`).
3. **The interface and the API** record what the owner asks. They cannot execute. The API and the engine are
   separate processes; either can be stopped without the other acting wrongly (`evidence/20261120-recovery.json`).
4. **The model** proposes and nothing else. It is given no tool and no credential. Its output is parsed against a
   schema, turned into a draft by the same validation an owner's own draft passes, and becomes authority only
   when the owner signs it. A figure the owner typed that the proposal does not use is flagged by fixed code.
5. **Market data sources** are public and unauthenticated. No single source is trusted: a price older than its
   limit cannot be used to execute; a digital-asset order needs a second, independent price within 3%; a
   protective sale needs the same confirmation.
6. **The paper venues and the local chain** are part of the build. Their books are compared with the ledger after
   every action.
7. **This computer** is trusted completely. Anyone who can run code as this user can read the database and edit
   the software. That is a property of a local build, not something it defends against.

## 3. Threats considered, and the defence

| Threat | Defence | Evidence |
|---|---|---|
| Another site makes the owner's browser act (cross-site request, DNS rebinding, a plain form post) | Origin and fetch-site checks, a per-session token, a Host allowlist, a required client header, SameSite=Strict | Checked: security `csrf` group |
| Reading or acting on another owner's data | Every query is scoped to the session's owner; ids of another owner answer "not found" | Checked: security `access` group |
| An approval forged, replayed, altered after it was read, or used after it expired | The approval binds the hash of the exact document, is consumed once inside the engine's decision, must be confirmed within ten minutes of being asked for and used within five minutes of being confirmed | Checked: security `approval` group; `server/programs.test.ts` "an approval is for one exact document" and "an approval request expires"; `server/execute.test.ts` "an approval that is not used within five minutes cannot be used". Until 20 Nov a confirmed approval could be used at any later time; an adversarial review found it |
| An instruction that exceeds what was signed | Limits per run, day, month and run count, scope of instruments and payees, end date, all checked at decision time against usage on record | Checked for the monthly limit, the run count and the end date: `server/programs.test.ts` "refuses a run that would exceed the monthly limit", "a limit on the number of runs counts runs still in progress", "authority ends on its end date". The per-run and per-day limits and the scope are enforced by the same code and have no test of their own. Until 20 Nov the run count was read only after a run had finished, so a purchase that takes a day to complete could be started again and again; an adversarial review found it |
| An instruction that takes money something due will need | The bank reserve: the least that covers everything listed at its worst, enforced on every instruction-origin outflow, day by day: an instruction may make no day ahead worse | Checked: `server/liquidity.test.ts`, at the rule and through the engine; the mathematics against exhaustive search in `experiments/r6/E1-flow-envelopes`. Until 20 Nov the rule compared only the largest shortfall, which let an instruction pay a later bill early while short and leave an earlier instalment uncovered; an adversarial review found it |
| A run executed twice (restart, duplicate tick, two engines) or late | One claim per occurrence by a unique key; an action not started within 150 s is refused; what fell due while the engine was down is recorded as missed | Checked: `server/programs.test.ts`, `evidence/20261120-recovery.json`, `evidence/20261120-overnight-sleep.json` |
| A payment sent twice after a timeout | One economic id per action; an unknown outcome is looked up, never re-sent | Checked: recovery scenario 1; `server/execute.test.ts` |
| A stale or manipulated price | Freshness limits; independent cross-check; refusal, never a late send | Checked: `server/execute.test.ts`, `server/programs.test.ts` |
| A model persuaded by text in its context (a payee name, a memo) | It can only propose; the owner signs the exact document; the engine re-checks | Read. One live run recorded in `evidence/20261120-model-proposal-path.json`. **No adversarial prompt corpus was run against a model** |
| Guessing a password; finding which handles exist | scrypt; the same answer and the same time for a wrong password and an unknown handle; lockout after repeated failures; a list of common passwords refused | Checked: security `account` group |
| A stolen session weakening a protection, or moving money in small pieces (Superseded 22 Nov 2026: a session alone approves nothing; protections need a fresh passkey step-up, see section 8) | The password is asked again to lower the floor, to weaken the reserve's assumptions, for any change of the household's figures or removal of a bill that lowers what must stay in the bank, to stop being stopped, and to sign out everywhere. Without the password a session can approve less than ₹10,000 of orders and payments in any 24 hours, however it is split | Checked: security `protection` group (six checks); `server/liquidity.test.ts` "a change that lowers what must stay needs the password"; `server/execute.test.ts` "without the password a session can approve less than ₹10,000 in a day". Until 20 Nov only the floor and the two reserve assumptions asked for the password, and the ₹10,000 threshold was per action; an adversarial review found both |
| The record edited afterwards | The database refuses updates and deletes of ledger entries and of receipts; each receipt's fingerprint covers the one before; the interface recomputes the chain in the browser | Checked: `server/ledger.test.ts`; `server/execute.test.ts` "a receipt cannot be edited or deleted, and if the protection were removed the chain check would show the change"; `npm run verify` |
| A leaked secret in the repository | Scan of the committed tree | Checked 20 Nov: gitleaks 8.30.1, 174 pattern hits, all of them public chain data in the vendored release evidence, a test identifier or the list of common passwords. The two release files that hold published private keys were never copied |
| A vulnerable dependency | Exact versions, lockfile install without install scripts | Checked 20 Nov: `npm audit`, 0 of 117 packages for the app. The chain part pins the release's versions and carries two advisories (esbuild 0.23.1, medium; elliptic 6.6.1, low); see `chain/README.md` for whether each is reachable |
| A local process floods the vault service, or one owner's script does | The service keeps its own budget, stored durably: 240 proposals, 240 operations and 4 scripted economies in any hour, and at most 16 unfinished operations. Past that it refuses and says when to try again. Reads use none of it | Checked: `chain/test/quota.test.ts`; `evidence/20261120-vault-journey.json` |
| A payment from the vault to anyone but the approved payee, or above what the co-signer allows | The payee is named by a label from a fixed book, never by an address; the release's co-signer re-derives every fact and applies its own eight rules, one of which is an earned allowance; the contract checks payee, amount and certificate again | Checked: `chain/test/treasury-ops.test.ts`, `chain/test/cosigner-checks.test.ts` |
| A fault in the vault's contracts | They are the release's, unmodified. Static analysis | Checked 20 Nov: Slither 0.11.6, 62 findings, the 3 high ones read and judged not exploitable (`evidence/20261120-slither-contracts.json`). **Not an audit** |

The active checks are in `evidence/20261120-security-active.json`: 54 of 54 on an isolated copy, in eleven groups
(session 7, csrf 7, headers 2, access 5, approval 8, input 12, account 3, limits 1, protection 6, interface 1,
integrity 2). Five of the six protection checks were added on 20 November for the faults the adversarial review
found.

## 4. What was not done

- No independent review, penetration test or audit of anything. The two reviews that were done (a clean-room
  review of the reserve's mathematics and an adversarial reading of this build's claims) were by agents of the same
  model family as the author.
- No adversarial prompt corpus against a real model on the proposal path. The release's 32-case corpus is run
  against the deterministic guard only.
- No fuzzing of the HTTP surface; no load test; no test with two browsers racing each other on one approval
  beyond the single-use check.
- No formal proof. The no-regret check is two independently written checkers that must agree; the reserve is
  equal to exhaustive search on small cases. Neither is mechanised.
- Static analysis of this repository's own TypeScript is the compiler in strict mode and nothing more.
- The rail's own HTTP surface was exercised by its tests, not by an attacker's script.

## 5. Residual risks, in order of how much they matter

0. **Faults nobody has looked for yet.** On 20 November one read-only review by an agent of the author's own model
   family found five real faults in authority and safety that the author's 662 tests had passed over, and it read
   only the reserve, a fifth of the capability rows and five rows of this document. The chain part, the paper
   venues, authentication and most of the engine have had no such reading. The same day, with 677 tests passing
   and both reviews done, the author found four more faults by reading the pictures the evidence scripts take: two
   wrong figures on an instruction's page, sums of money written with one decimal place, and keyboard focus left
   under the bars pinned to the window. None moved money, but two of them told the owner something untrue. A
   reviewer outside this work should be expected to find more. Everything below is a risk the author knows about;
   this one is the risk of the rest.
1. **Limits on how far a holding can fall are illustrative.** The worst case and the floor are only as good as
   those limits, and they have not been calibrated against price history. The interface says so wherever they
   are used. Until they are calibrated the floor is a demonstration of a mechanism, not a protection.
2. **The reserve covers only what is on record, for the days it looks at.** Recurring bills not yet registered, and
   spending above the owner's own figure, are outside it. It looks 150 days ahead from each day, so it can rise as
   later payments come into view. Money the owner records by hand is not recognised as a salary, so a salary that
   arrives that way is still counted as outstanding; in this build the paper bank pays the salary itself.
3. **One password.** (Superseded 22 Nov 2026: see section 8.) There is no second factor, no passkey, no recovery,
   and no way to change the password in the interface.
4. **The local chain's owner key is held by the rail's own process.** (Superseded 22 Nov 2026 for owners' vaults:
   see section 8.) An approval is bound to exact terms, but
   nothing stops code in that process from signing. A signer the service does not hold is designed, not built
   (`chain/docs/owner-signer-design.md`; three choices in it are the owner's).
5. **The engine stops when the computer sleeps.** What falls due is recorded as missed, which is honest but is
   not availability.
6. **A model sees the owner's position when Ask is used.** It is a summary without credentials, and the screen
   says what is sent, but it leaves this computer.
7. **Everything is in one unencrypted database file** readable by this user.

## 6. What a move to real money would require

None of this is started, and none of it may start without the owner's separate approval.

- An independent audit of the contracts and of the engine's decision and execution path; a penetration test.
- Calibrated limits with their evidence, or no autonomous purchase of anything that can fall.
- Real venues behind the same contract the paper venues implement, each with its own reconciliation; licensed
  market data, since the present sources are used under terms for the owner's own review.
- Custody decided: who holds keys, with hardware or threshold signing; no signing key in a service process.
- Strong authentication (passkeys), recovery, device management; TLS everywhere; secure cookies; encryption at
  rest; secrets in a managed store.
- An engine that is always on, with one leader, monitored, and a tested restore.
- Identity checks, record keeping, tax reporting and the licences each jurisdiction demands. Not legal advice;
  see `docs/research/qed-fin-infra-compliance/`.
- A red-team of the model path with a published corpus, and a standing rule that the model never gains a tool.

## 7. Decisions that are the owner's

| Decision | Why it waits |
|---|---|
| F-060: the release publishes private keys of a Sepolia vault in two files | Not copied into this workspace. Whether to keep, rotate or retire them is the owner's |
| F-052: the zero-knowledge module carries GPL-3.0 code | Built as an optional tier, off by default; shipping it has licence consequences |
| F-039, F-054: claims limited to constant-product pools and to synthetic inputs | Whether to state them more narrowly in public material |
| F-063, F-071, F-074: the Sepolia evidence verifier, the public bounded mode, sandbox reset | Each touches the public deployment or a public chain, which this work may not |
| Market data display | CoinDCX and AMFI data are shown for the owner's own review. Any public showing needs their terms checked or a licence |
| Running the engine anywhere but this computer | A hosting decision |
| Whether a holding's limit may stay illustrative in a review build | Or whether autonomous purchases should be switched off until calibrated |
| R13 guardian: a frozen passkey cannot cancel a recovery the guardian co-signed (built as asked) | The alternative keeps that veto while every member is frozen, which blocks a misused sentinel but restores the hostage case when every device is stolen (section 8i) |
| R13 time-lock: turning it on is immediate, turning it off waits the delay (built so) | Both directions behind the delay is a one-line change in `setTimeLock`; on-at-once matches how thresholds are raised |

## 8. What changed since 20 November (22 November 2026)

Each line says what is now true, what it supersedes above, and what ran.

- **Passkeys, not passwords.** Sign-in, re-authentication and every approval are passkeys (WebAuthn, ES256, user
  verification required); an account made since R7 has no password. An older account keeps its password for sign-in
  and as the second method of a recovery only; approving terms always needs a passkey. Supersedes section 1 "The
  owner's password" and section 5 item 3. Checked: `evidence/20261122-security.json` (102 of 102).
  **Amended 23 November (D-094):** an account may again be opened with a handle and a password
  (`POST /api/auth/signup`, `server/passkeys.ts` `signUpWithPassword`), as the owner asked for ordinary sign-in.
  - *What a password session can do:* read everything, set up the household, prepare work for a passkey to approve
    (payees, bills, drafts, approval requests), pause QED, pause or revoke an instruction that does not sell to
    protect, and add the account's first passkey right after the password was typed (at sign-up, or by typing it
    again: the freshness lasts five minutes and a sign-in alone gives none). On an account with no passkey it can also
    change the password, with the current one typed again in the same request (below).
  - *What it cannot do:* approve anything (the approval route has no password path; every approval is a passkey
    signature over the exact terms); weaken a protection or restore spending authority, each of which needs a fresh
    passkey confirmation that a password never gives (`stepUpFresh` is passkey-only, `server/auth.ts`): lowering the
    floor or the reserve, removing a counted bill, clearing a pause, opening a business, changing members, policy,
    passkeys or vault signers, changing the password of an account that has a passkey, removing a password, naming or
    ending one's own recovery contact, resuming a paused instruction, and pausing or revoking an instruction that sells
    to protect (an exit or a floor) or cancelling one of its runs. A pause asked for from a password session keeps
    protective selling running unless a passkey confirms it.
  - *Recovery, changed by the review of this amendment:* a recovery started with a saved code and the password (or a
    contact's code) is finished only with the reference its start returned, whose secret the database keeps as a hash;
    the request id that every session of the account sees no longer finishes it. Cancelling a recovery, making new
    saved codes, and stepping down as someone else's recovery contact each need the strongest confirmation the account
    can give: a passkey, or, on an account with no passkey, the password typed again. A password re-entry adds one
    passkey, the account's first; a second ceremony begun in the same window is refused when it finishes.
  - *Changing and removing it (later on 23 November; RISK-076's next step):* Security has a Password panel while the
    account has a password (`src/screens/Security.tsx` `PasswordPanel`; `server/passkeys.ts` `changePassword` and
    `removePassword`; `POST /api/security/password` and `POST /api/security/password/remove`).
    Changing it takes the strongest confirmation the account can give. With no passkey it is the current password,
    typed again in the same request, as ASVS 5.0 V6.2.3 asks of every change: the five-minute password freshness that
    `strongConfirm` accepts elsewhere (a sign-up opens one) is not enough when the password is the thing being changed.
    With a passkey it is a fresh passkey confirmation instead, and the current password is not asked for, which departs
    from V6.2.3 on purpose: a password session cannot change it, even with the current password typed again, and the
    owner can without remembering the old one. The new password passes the sign-up rules (`validateCredentials`,
    `guessable`) and must differ from the current one. A wrong current password counts against the step-up's limit
    (eight in fifteen minutes per person), which the two routes share; each attempt is counted before its password is
    checked and given back when it was right, so guesses sent together are held to the same eight (`checkRetyped`,
    `server/auth.ts`, which the step-up route now uses too).
    Removing it needs a passkey that can sign in, a fresh confirmation with one, and a way back in without the
    password. A recovery takes a saved code and a code from a second method, and the password was one of the two
    methods; a contact issues a code only after confirming with their own passkey. So at least one unused saved code
    and an active recovery contact who has a passkey must exist, read in the same transaction as the removal. The
    password then opens nothing: sign-in answers as it does for an unknown handle (a lock left by wrong passwords is
    cleared with it), and a step-up or a recovery with it fails, including a recovery whose password check was under
    way at that moment. Nothing in this build adds a password back, and the sheet says so.
    Either change ends every other session of the account at once, and the live event stream of an ended session
    closes within a second (every stream now checks its session each second). The session that made the change stays,
    and the change is written only if that session, its confirmation and whether the account has a passkey are what
    they were when the request began. Each route counts every attempt that carries its confirmation, thirty in fifteen
    minutes from one address (sign-in's own figure) and ten per person; an attempt refused for want of one costs no
    hash and is not counted, so a phished password cannot use up the owner's allowance. Suspending a passkey now also
    withdraws every other session's passkey confirmation, so one it gave a session it did not open (one opened with a
    password, say) ends with it; those sessions confirm again.
    The panel says what the server does: the removal sheet lists the three conditions and offers the removal only when
    all hold, and the sheets say that the passkey is asked for unless it confirmed in the last five minutes (that
    confirmation is not tied to this change, RISK-068). The recovery path above it no longer says that a contact with
    no passkey can issue a code.
    What remains:
    1. On an account with no passkey, whoever knows the password can change it too, and so lock the owner out of
       password sign-in. A recovery then needs a saved code and a contact's code, because the old password no longer
       stands in. This adds to RISK-076's first residual; adding a passkey closes both.
    2. A stolen passkey, with its unlock, can change or remove the password at once, as it can do most things here.
       Suspending it from another passkey ends its sessions and every other session's confirmation.
    3. The removal's conditions hold at that moment only. A contact may step down, lose their passkeys, or the saved
       codes run out later, as on any account made with a passkey. Security then says so; Home says so only while a
       single passkey is left.
    4. Changing or removing the password does not cancel a recovery already started with it. Every page of the account
       says that a recovery is open, and Security cancels it.
    5. Anyone who knows a handle can use up its ten recovery attempts a day without being told (`startRecovery`; older
       than this change). Once the password is removed a recovery is the only way back, so this matters more.
    6. Every request reaches this build from the loopback address, so the per-address figures (sign-in's and these
       routes') are shared by everyone using it.
    7. A session freshly confirmed with a passkey can try ten passwords per fifteen minutes against the current one
       through the "must differ" check; such a session can already change the password to anything.
    8. Work prepared in a password session is still recorded as the owner's (RISK-076's fourth residual). Marking it
       needs a schema change across payees, bills, drafts and approvals, and was not done here. (Closed later on
       23 November: see "Work prepared in a password session" below.)
  - *Work prepared in a password session (later on 23 November; RISK-076's last item):* every payee, bill,
    instruction draft (each saved version) and approval request made in a session records how that session was opened,
    and when, in a table that is written once and refuses any change or removal (`prepared`, `server/schema.sql`;
    `server/prepared.ts`). The method is read from the session's own record through the request's actor, never from the
    request. A document a passkey signs carries one sentence for each part of it that a password session prepared: the
    request itself when a password session asked for it ("Prepared in a password session at 14:02 IST on 23 Nov 2026,
    not with a passkey."; not for a run's approval, which QED planned), the draft it puts in force, the payees that a
    payment, a bills instruction or a run pays, and a bill that a payment or a run pays. In a business workspace the
    sentence names the member. The approval sheet shows the sentences above the document and offers the passkey only
    once it has read them for that request (`src/ui/instrument.tsx` `usePrepared`, from `GET /api/approvals/:id`). For a
    payment, an instruction or a run they are inside the document whose hash the passkey signs, so the approval's record
    keeps them, and the evidence cases show them (`documentAsSigned.prepared`; a run's `signaturesUsed`). Work prepared
    with a passkey reads exactly as before. A payee added in a password session is told to every member of the
    workspace in Security's history ("What happened"), with the payee and the time.
    What remains:
    1. That history is the only notice, and it is inside the app: someone who never opens Security is not told.
    2. An instruction's own page shows its signed document without the sentence; it is in the record and the evidence.
    3. For a request to the on-chain wallet the sentence is shown and kept in the approval's document, but the passkey
       there signs the chain's digests, not that document.
    4. Money recorded by hand (`POST /api/money-in`) and earning jobs are not marked; neither is approved by a passkey,
       but money marked as earned can start an instruction that splits income.
    Checked: `server/password-prepared.test.ts` (5 tests), `browser/tests/password-prepared.spec.ts`.
  - *Rules:* passwords are scrypt-hashed (N 2^17), 10 to 200 characters, and refused when they hold the handle, are a
    common password, are a common word with digits or symbols added, repeat one character, or run up or down the
    alphabet or the digits (`guessable`, `server/auth.ts`). Sign-up shares the 20-an-hour-per-address limit with
    passkey sign-up; sign-in locks an account for 15 minutes after five wrong passwords; cross-site requests are
    refused for every route.
  - *What it adds* (RISK-076): a phishable secret. Until the account has a passkey it is the only credential: whoever
    holds it can add the first passkey and with it the authority to approve, which is why the first run offers the
    passkey at once and Home asks for it until it is added. A password-only account whose owner forgets the password
    and has named no recovery contact cannot be recovered; the codes screen and the passkey step say so. A password
    could not at first be changed or removed in the interface; since later on 23 November it can (above).
  - *Checked:* `server/signup-password.test.ts` (6 tests: the account, the freshness, no approval, the first passkey,
    the rules, and a recovery that starts, waits and is cancelled); `server/password-session-routes.test.ts` (7 tests
    over HTTP: the four refusals above; a recovery finished only with its reference; cancelling it from a password
    session refused on an account with a passkey; two ceremonies racing for the first passkey; a pause that keeps
    protective selling and a floor instruction that cannot be paused or revoked); `server/guessable.test.ts`;
    `browser/tests/signup-password.spec.ts` (a password account signs in again and cannot approve a payment). Run
    results: `evidence/20261123-unit-tests.json`. Changing and removing it: `server/password-change-routes.test.ts`
    (11 tests over HTTP against the real API. A change with no passkey needs the current password in the request, and
    refuses a wrong one, each sign-up rule and the same password, then ends the other live session (a lapsed one is
    not counted). Wrong current passwords share the step-up's limit, one at a time and twelve sent together. On an
    account with a passkey a password session cannot change it and a fresh passkey can without the old one. A removal
    is refused with no passkey, without a fresh passkey, with no contact, a contact not yet active or one with no
    passkey, and with no unused saved code; afterwards the password opens nothing, even on an account locked by wrong
    passwords. Refused attempts are not counted, confirmed ones are, per person and per address. Suspending a passkey
    withdraws the confirmation it gave a password session. A stream of an ended session closes. A session ended while
    its change is being hashed changes nothing). `server/signup-password.test.ts` adds a recovery whose password
    changes while it is being checked, which starts nothing. `browser/tests/password-change.spec.ts` (the same journey
    through the interface: a change that signs out a second browser, and a removal offered only once a recovery
    contact is active). Every state photographed at 1440 and 390 px in light and dark, with axe-core's WCAG A and AA
    rules and a sideways-scroll check on each (`scripts/password-shots.ts`, `evidence/design/password-change/`: 32
    photographs, no violation). An adversarial review of this change (same model family, read-only) found five medium
    and ten low points; each fixed here was first shown by a failing test (EV-069 lists them). Run results:
    `evidence/20261123-password-unit-tests.json`, `evidence/20261123-password-browser-suite.json`.
- **Recovery and suspension** (decision D2a, `docs/r7/00-ARCHITECTURE-DECISIONS.md`): two codes from different
  methods (a saved code and a recovery contact's code, or for an older account its password), then a 72-hour
  cancellable delay; a stolen passkey is suspended at once by another. Checked: `evidence/20261122-recovery.json`
  (15 of 15).
- **Each household's vault is owned by its own passkeys.** The vault service now serves many owners. A household
  that sets up its vault gets its own owner account on the local chain (`QEDOwnerAccount`, `chain/accounts`) whose
  signers are the passkeys it had at that moment, and its own vault set; the vault service holds no key that can
  satisfy that account and only relays what the passkeys signed. Every owner action lists the digests the chain will
  check; the passkey signs each one, QED verifies the assertion, and the chain checks it again before anything runs.
  The service's own keys (agent, guardian, relayer) are derived from a 32-byte secret created on this computer with
  mode 600, not from public strings; none is a signer of any owner account. The release's development keys remain
  only in the rail's baseline-parity mode, for its parity tests, which the wallet does not use. Supersedes section 1
  "The rail's bearer token and the local chain's development keys" and section 5 item 4 for owners' vaults.
  Checked: `server/rail.test.ts` (what QED sends, to which vault, and what it refuses), `browser/tests/vault.spec.ts`
  (a household sets up, accepts, signs a mandate and pays in the browser; two households, one paused, the other
  untouched; one cannot read the other's proposal), `chain/test/workspaces.test.ts` (no key of the service can sign
  for an owner account; a passkey that is not a member is refused on chain).
- **Earning on the chain** (R7-054, later on 22 Nov): Earn's "Work paid through escrow on the chain" runs a job between
  two QED wallets through the release's ProofEscrow and MinVarianceVerifier, unmodified: the provider's passkey signs
  the quote, the client's passkey funds it from its own wallet in one transaction, the verifier checks the delivered
  certificate before the escrow pays, and without verified work by the deadline the client takes the money back.
  Before the deadline the provider can release the client instead, and the escrow refunds the client's own account on
  the chain; a proof escrow has no dispute step. A settlement adds half its price to the provider's authority budget only from a client that shares no member, now
  or ever, and no key with it; QED cannot tell whether the same person runs another QED account or pays from an
  address outside QED, and two different people who pay each other back and forth raise both budgets with real money.
  Checked: `chain/test/escrow-earn.test.ts`, `server/earn-chain.test.ts`, `browser/tests/earn-chain.spec.ts`.
- **New residual risks, in order:**
  1. The owner account is research code (`chain/accounts`), declared ready after its own tests (`READY.json`: 155
     Forge tests, invariants, Slither findings dispositioned), not audited by anyone independent.
  2. (Superseded later on 22 Nov, RISK-053: signers and recovery from QED.) Under Security, "Who can sign for your
     on-chain wallet" now adds a passkey of the same person (or, in a shared workspace, one passkey per member who may
     sign) as a signer, signed by the account's admin threshold over the exact terms and applied at once, because the
     contract makes additions immediate (they lower no threshold); removes signers and lowers thresholds behind the
     account's delay, cancellable by any signer the change does not remove; and sets up a recovery key the browser
     derives from a code it shows once (scrypt N 2^15, as `chain/accounts` `RecoveryKey`; the server receives only the
     public key, a proof of possession and signatures). A recovery adds one passkey after the 72-hour recovery delay,
     any signer can cancel it, and the code is spent either way. QED sends nothing a suspended passkey signed, offers a
     passkey for no cancellation of its own removal, and warns while a suspended passkey is still a signer on the chain.
     Checked: `chain/test/signers.test.ts`, `server/rail-signers.test.ts`, `server/rail-recovery-key.test.ts`,
     `browser/tests/vault-signers.spec.ts`. What remains, in order:
     a. A household's threshold is 1, so a stolen passkey with its unlock is a full signer on the chain until its
        removal applies (72 hours by default): it can act directly on the chain, outside QED, which only refuses it
        inside QED. Remove it together with any key it added in one removal (no key a removal takes away can stop it),
        pause the wallet, or raise the threshold to 2 so that one device alone can only veto.
     b. On the chain a recovery checks only the code. QED relays one only for a session freshly confirmed with one of
        the person's passkeys, and only to add one of that person's own active passkeys (it does not yet require the
        confirming passkey to be the one added), but someone with the code and direct access to the chain can start
        one; every signer can cancel it for 72 hours. With every device lost and the code stolen too, no signer is
        left to cancel.
     c. After QED's own account recovery (72 hours) the wallet's recovery adds its own 72 hours: 144 hours at worst.
     d. Every change of who signs is told in the app only; no notification leaves it (§4.6).
     (Updated 24 Nov, R13; the owner's rule R12: a recovered sign-in must not silently grant a new financial signer or
     unrestricted vault control.) What is now contained, and what is not:
     - *b, QED's side (contained):* QED relays a wallet recovery only when the passkey it adds has itself confirmed that
       very request: the server issues a challenge bound to the request and its digest, offers it to that passkey alone,
       and refuses an assertion by any other passkey of the person, a confirmation made for another request, or none
       (`confirm_with_added_passkey`, `confirmation_needed`; nothing is sent, and a refused attempt is recorded in the
       person's history). Checked: `server/rail-signers.test.ts` ("relays a vault recovery only when the passkey being
       added confirms it"), `browser/tests/vault-signers.spec.ts` (the recovery step, its prompt offered only to the
       passkey being added).
     - *b, on the chain (not contained):* a recovery still checks only the code there. Someone with the code and
       direct access to the chain can start one; every signer can cancel it for 72 hours, a frozen one included. With
       every device lost and the code stolen too, no signer is left to cancel. The designed fix is a guardian (the
       person's recovery contact, own key) whose co-signature a recovery needs: designed in `chain/accounts/README.md`
       "R13", not built.
     - *a, for wallets set up from this build on (contained at once):* suspending a passkey in QED freezes it on the
       chain in the same request: the vault service's sentinel key (one derived key per workspace) calls the owner
       account's `freeze`, and from the next block that passkey's signature moves no money, signs no mandate (a mandate
       it alone signed stops paying) and changes no signer, threshold, delay or scheduled change. A freeze that could
       not be sent is sent again on the engine's next vault round (every five minutes), which also catches a passkey
       suspended or removed in any other way. Checked: `chain/accounts` Forge (181 tests, 8 invariants, a seeded twin
       that counts frozen approvals and fails), `chain/test/containment.test.ts` (real local chain),
       `server/rail-signers.test.ts`, `browser/tests/vault-signers.spec.ts` (suspend in Security, frozen on the chain).
     - *a, what a frozen passkey can still do:* cancel a scheduled change (not its own removal) or a recovery, which
       spends the code; and stop things through `protect` (pause either vault, bump the epoch, revoke a mandate or the
       standing policy), which one passkey may do whatever the threshold. A thief holding it can keep doing that until
       its removal applies (72 hours). It cannot be unfrozen by itself or by the service, only by the wallet's unfrozen
       signers.
     - *a, not contained:* a thief who acts before the passkey is suspended has its full power at threshold 1, as
       before; the freeze needs QED's service to be running when the passkey is suspended (otherwise the next round
       freezes it); a wallet set up before this build has no sentinel, gains nothing, and its view says so (it needs a
       new wallet: the account cannot be upgraded); allowing a passkey again in QED does not unfreeze it on the chain
       (remove and re-add it, or unfreeze it with the other signers directly on the chain: QED does not offer that yet).
     - *The sentinel is a new power held by the service.* Abuse case: the service's sentinel key freezes a passkey it
       should not, or all of them. Limits: no money moves, no mandate is signed and nothing about the signers changes
       through it; every signer keeps its veto and `protect`; the household cannot spend while every signer is frozen.
       It ends this with any unfrozen signers (unfreeze and drop the sentinel at once), or, with every signer frozen,
       with its recovery key: after the recovery delay, finishing the recovery and dropping the sentinel in one
       transaction (tested in Forge; QED does not offer this path, it needs direct access to the chain). A household
       with no recovery key and every signer frozen stays unable to spend until the key's holder stops. No key of the
       service can sign for an owner account, for any movement of money: the sentinel holds an address, not a passkey,
       and is refused by `execute` and ERC-1271 (`test_the_sentinel_has_no_other_power`, `chain/test/containment.test.ts`).
     - *Item 3 of R13, two devices for payments (not offered):* the account enforces a threshold of 2 already, and one
       device can still stop the agent through `protect`; but QED collects one signature per person for an approval,
       so a household at threshold 2 could not sign through QED. The screen does not offer it; the design is in
       `chain/accounts/README.md` "R13". Per-signer daily limits were rejected as not enforceable on the chain.
     - *c and d:* unchanged. The freeze is told in the app only (a notice and the person's history).
  3. A vault takes signatures from one web address, fixed when it is set up. Opening QED at another address shows
     the vault but cannot sign for it.
  4. The release's earned-autonomy rule, kept as it was (decision D-A), lets the agent pay out 10 units of the
     vault's asset plus half of verified escrow revenue, and counts conversions as spending: after a conversion of
     more than 10 tINR, payments from the treasury are refused until escrow revenue arrives. Decision D7 replaces
     the rule; it is not built.
     (Updated later on 22 Nov, when D7 landed.) In every owner's vault the co-signer's check C12 is now the authority
     budget of D7: payments to others consume it, a conversion only its real cost against a fixed reference band, and
     owner grants (passkey-signed, reported apart) and earnings from clients outside the workspace add to it; round
     trips and self-dealing cannot raise it (`chain/test/authority*.test.ts`). It is a co-signer check, not on the chain:
     a stolen co-signer key bypasses it. Its reference band is fixed (84 tINR per tUSD, plus or minus 0.5%) and does not
     follow the shared test pools, so once they drift outside it every conversion is refused until it is re-centred;
     a grant takes effect at once with the account's ordinary threshold. These figures and choices are the owner's.
  5. Shared (business) workspaces (updated later on 22 Nov, when their vaults landed; and again with RISK-053: a member
     added later can now be made a signer, one passkey per member, and the chain's threshold changed, never below the
     workspace's own count): the owner account's signers are one passkey of each member who may sign and its
     threshold is the workspace's count at set-up. A larger count
     the workspace asks for above a size is checked by QED, not by the chain (the account has one threshold). Since
     RISK-053's screens, a member or passkey added later becomes a signer only when the threshold of signers adds it,
     and the threshold can be changed on the chain, never below the workspace's own count. Checked:
     `browser/tests/business-vault.spec.ts`, `server/rail.test.ts`.

### 8a. Re-authentication after the claims review (22 Nov 2026, evening)

An assertion made to approve one document no longer refreshes the session's re-authentication: only a step-up made
as a step-up does (`server/passkeys.ts` finishReauth; `server/passkeys.test.ts`, "an assertion made to approve a
document does not refresh..."). Before this, approving any payment opened five minutes in which a passkey could be
added, the recovery codes replaced, another passkey suspended or QED resumed with no further prompt. What remains:
a passkey sign-in still counts as a re-authentication for five minutes, and adding a passkey takes effect at once,
so same-origin script in that window (a browser extension, or an XSS, of which none is known) could add its own passkey.
In this build the computer is trusted (section 2.7); for any hosted or real-money version, binding a passkey should
need an assertion made for that change and wait out the delay that removing one waits.

### 8b. The development server and the data folder (23 Nov 2026)

The development server (Vite, `npm run dev`, the review build on 5174) serves every file under this folder by its
path. Until this change it also returned `data/`, the running service's state, byte for byte: the database and its
copies, the rail token, the review account's sign-in and fixture sessions, by the plain path and through `/@fs/`. It
listens on the loopback address only, so the exposure was to this computer: other users and processes on it, and
pages on other `localhost` origins, which Vite's default cross-origin rule admits. `vite.config.ts` now refuses the
folder by its absolute path beside Vite's own default list (`server.fs.deny`). Checked:
`server/dev-server-files.test.ts`, which starts a dev server with this config and asks for a probe file in `data/` by
the plain path, `/@fs/`, a percent-encoded path, `?raw`, `?import` and another case (403 each; a doubled slash gets
the app page). It fails without the change. The API and the design fixture serve only the built interface: the
same paths get 404 from both. The review account's password was not rotated (`scripts/review-password.ts` does
it); that is the owner's call.

### 8c. What R10 added, and its threats (23 Nov 2026)

| Threat | Defence | Evidence |
|---|---|---|
| A phished password, or a stolen cookie, used to add a passkey or start a recovery while the owner is not looking | Every change to who can act (passkeys added, removed, suspended; password changed or removed; recovery started or completed; codes replaced; a wallet recovery; a protection lowered; a payee added in a password session) is also an urgent notice on Home with what to do if it was not the owner. Urgent notices are never held for quiet hours and are raised again once if nobody acknowledges them | Checked: `server/notify.test.ts`, `server/notify-routes.test.ts`, `browser/tests/notifications.spec.ts` |
| The same session then clears the notice that warns of it | A notice of a change to who can act (for the account or its wallet) is acknowledged only from a passkey session, after a fresh passkey confirmation, or on an account with no passkey (its password is its only credential), as cancelling a recovery is (review M1). The screens ask for the passkey. What was acknowledged stays listed for seven days, and the security history keeps every event | Checked: the unit and route tests above (a password session with a fresh password confirmation is refused 401 `stepup_required`; the owner's passkey confirmation settles it) |
| Too many notices, so the one that matters is missed | Urgency per kind; quiet hours hold warnings only; information goes to one daily digest grouped by kind; identical events give one notice; a completed recovery is told once | Checked: `server/notify.test.ts` |
| Passkey autofill signs someone into the wrong account on a shared computer, or a ceremony left pending completes later | The browser's own chooser names each account; the request is cancelled when the sign-in form closes (`WebAuthnAbortService`); the session it opens is an ordinary passkey session, and anything that lowers a protection still needs a fresh confirmation | Checked: `browser/tests/passkey-autofill.spec.ts` (virtual authenticator only; no real device yet, R10-005) |
| A question handed from the Ask dock leaks through the address bar or history | It is passed in memory (`handAsk`), never in the URL; payees reach the model only as anonymous labels | Read: `src/lib/core.ts` |
| Two instruments confused (same symbol, different chain or precision) | Every amount is to carry a canonical instrument id (ISO 4217, CAIP-19, custodial claims) with exact minor units; stage S1 formats rupees through it, S2 adds ids to the books | `shared/instrument.ts` and its tests; ADR-0012; S2 in progress |
| A bank's or card's credentials held by an agent path | None exists: the bank is paper and the chain local. Any future integration must not hold a customer's bank credentials (proposed G1) | EV-073; Q-068; RISK-079 |
| The release's refutation bounties paid to whoever copies a pending claim first | The release's SECURITY.md says claims are "not front-runnable for profit", but the contracts pay the sender of the first valid claim. Nothing in this wallet makes that claim; a local test is being written to settle it | `docs/research/qed-research-intel/20261123-refutation-bounties.md` (claim C-6, Conflict by reading) |

Not done: delivery outside QED (email, text, push) needs a provider and the owner's approval (24 Nov, R12: still true of real delivery; the adapter, a local test outbox that sends nothing, and notices to confirmed addresses now exist, section 8e), so an attacker who holds
the only session is not seen out of band; the review password was not rotated.

### 8d. Encryption at rest and backups under R11 (24 Nov 2026)

| Threat | Defence | Evidence |
|---|---|---|
| A schema migration leaves a plaintext copy of every account's records beside the database (the four `qed.db.pre-vN-….bak` files of 20 to 23 Nov) | Before a migration the copy is sealed under a key of its own (the migration-copy keyring), read back and checked; only then does the migration run. Without the key, or if any step fails, the migration does not run, the database is left as it was, and the process stops with the reason and the fix. There is no fallback to plaintext | Checked: `server/migration-copy.test.ts`, `server/canonical-ids.test.ts`; the mutations "silent fallback to a plaintext copy" and "`openDb` migrates anyway" each fail tests |
| `npm run reset` moves the database aside in plaintext (the three `qed.db.2026-11-20T….bak` files) | It seals the database into the backup folder and removes it, or, without the backup key, refuses and changes nothing | Checked: `server/backup-cli.test.ts` ("npm run reset") |
| One key standing in for another (a backup key opening migration copies, a keyring relabelled or configured for the wrong purpose) | One keyring per purpose (database, reserved; backup; migration-copy), the purpose authenticated and checked at every use, key ids naming it, the KEK's derived keys separate per purpose. One KEK still wraps all of them: separation stops mistakes, not a KEK compromise | Checked: `server/key-separation.test.ts` |
| A backup that cannot be restored, found out only when it is needed | `npm run backup:verify` decrypts every backup, migration copy and archive in memory against its record and checks the keyring copies; `npm run backup:drill` restores the newest backup into a private scratch folder and runs `node server/main.ts verify` on it | Checked: `server/backup-cli.test.ts`; rehearsed on copies of the review data (`docs/ENCRYPTION.md`, section 6) |
| The plaintext copies already on disk | `npm run plaintext:archive` seals them under the backup key, checks each byte for byte, and leaves them in place; removal needs `--remove-plaintext` and the archive's id typed back, re-checks every original, and removes nothing if one differs or a database looks open. Deleting them is the owner's decision | Checked: `server/plaintext-archive.test.ts`; rehearsed on copies, never on the review data folder |
| Plaintext reaching the disk during a backup, a re-encryption or a check | Snapshots only in a private temporary folder, proven removable before use and shown gone after; re-encryption and checks decrypt in memory, stream to stream; a search of every file written for samples of every plaintext page found none | Checked: the leakage tests in `server/migration-copy.test.ts` and `server/plaintext-archive.test.ts`; the rehearsal's search (`docs/ENCRYPTION.md`, section 6) |

Not done: no key exists on the review machine yet, so the next schema migration there refuses until `npm run keys:init`
is run (after the owner decides where the key lives and how it is escrowed); the seven plaintext copies and
`scratch-backup-20261120/` are still on disk; the live database is protected by FileVault and file modes only; the vault
service's data is not backed up; there is no backup schedule, monitoring or off-host copy (`docs/ENCRYPTION.md`,
section 7).

An independent read-only review of the first version of this work (`cb85271`) confirmed six faults, now fixed, each
with a test that failed on `cb85271` first (`docs/ENCRYPTION.md`, status, lists them): a signal during a start-up
migration left the plaintext snapshot on disk, unswept (now signals wait for the step, and leftovers of a SIGKILL are
swept and reported by the next run: `server/interrupt.test.ts`); guards compared path text on a case-insensitive disk, so
the live database could be archived and then deleted under another letter case (now compared by device and inode, and
re-checked just before each removal: `server/path-identity.test.ts`); revoke missed copies outside the default folders,
left the revoked key in keyring copies, and accepted an older keyring put back (now every recorded folder is covered,
copies are rewritten, and an authenticated generation refuses a rolled-back keyring: `server/key-separation.test.ts`,
`server/backup-cli.test.ts`); Ctrl-C during a drill left its restored copy in the temporary folder (fixed as the first);
a refused migration folded a waiting write-ahead log into the database (now left byte for byte:
`server/migration-copy.test.ts`); one file named in two cases became two archive entries (now one). The archive record
is now sealed and authenticated as well.

### 8e. Getting back in under R12: password reset, account recovery and authority to move money, kept apart (24 Nov 2026)

The owner's R12 supplement (section 4) asked for recovery that is convenient without weakening financial authority. Three
things are now separate in code (`server/recovery.ts`, `server/passkeys.ts`), words and screens (`src/app/Access.tsx`,
Security and recovery):

1. **Password reset**, for an account whose way in is a password and that has no passkey that can approve: a link by
   email sets a new password. An account with a passkey that can approve is told by email to sign in with it: an email
   alone never opens a session on such an account. For the protection delay after a reset, the new password confirms no
   change to how the account gets back in (the review's M1, below).
2. **Account recovery**, for a person who has lost every passkey: a link to a confirmed email address and one more proof
   obtained another way (a saved code, a code from a recovery contact, or the account's password, unless a reset set it
   within the protection delay) start a recovery that waits, told on every channel and stoppable by any of the account's
   passkeys or recovery contacts; when the wait ends a new link, opened in the browser that started the recovery (it
   keeps the recovery's finishing key), lets the person make a new passkey, within seven days. The saved codes with a
   contact's code, without email, stay as the backup path (the R7 one), no longer the first thing offered unless the
   installation cannot send email. Each way finishes only a recovery it started (the review's H1, below).
3. **Authority to move money.** A passkey registered by a recovery (or added with the password after a reset) has
   *sign-in* authority only: it opens sessions with no confirmation in them, approves no payment, instruction or wallet
   change, confirms no change to protections (every check of a fresh confirmation refuses it with `authority_restricted`),
   is never offered as a wallet signer, and cannot set a wallet up. Approval authority comes back only through a separate
   request, made with that passkey, that waits the protection delay, is told to every device, address and recovery
   contact, and can be stopped by the passkey that asked, by any passkey with full authority, or by a recovery contact;
   a passkey with full authority may also grant it at once (the verification an expansion of authority needs). The
   on-chain wallet then accepts the passkey only under its own rules (its recovery key and delay, or its other signers).

Standards read for this section (accessed 24 Nov 2026): NIST SP 800-63B-4, *Digital Identity Guidelines:
Authentication and Authenticator Management* (https://pages.nist.gov/800-63-4/sp800-63b.html; the multi-page version
names the sections cited), and the OWASP *Forgot Password Cheat Sheet*
(https://cheatsheetseries.owasp.org/cheatsheets/Forgot_Password_Cheat_Sheet.html). Section numbers in NIST's single page
are not printed beside every heading; they are cited here as the document's own cross-references give them.

| Control | What it meets | Evidence |
|---|---|---|
| Reset and recovery links: 256 random bits (`randomBytes(32)`), kept in `one_time_tokens` only as their SHA-256 (the local test outbox also keeps each message's text, the link in it included, until the link is used, replaced or expires, when the link is taken out of that text: the review's L1), linked to one account and one purpose, single use (spent in the same transaction as the change), a newer link replaces the older, expiry 30 minutes (reset) or one hour (recovery) | OWASP "General Security Practices" (random, long, linked to one user, invalidated after use, stored securely); NIST 4.2.1.2 (an issued recovery code sent by email lasts at most 24 hours); NIST 3.1.2.2 (secrets of 112 bits or more may be stored with an approved hash) | Checked: `server/recovery.test.ts` "the link is stored as a hash, works once, expires after 30 minutes, and a newer one replaces it"; `browser/tests/recovery.spec.ts` (the hash read from the stack's database; the link used twice) |
| Links point at the one configured origin, carry the token in the fragment, and the page removes it from the address bar; every response says `Referrer-Policy: no-referrer` | OWASP "URL Tokens" (no Host header; a trusted URL; no referrer leakage) | Checked: `server/recovery-routes.test.ts` (`QED_LINK_ORIGIN` must be an allowed origin; a public origin is the only link origin); the journeys check that the address bar holds no token |
| A request for a reset or a recovery answers `{ ok: true }` for every identifier, in at least 450 ms; what happened is said only to the account's confirmed addresses | OWASP "Forgot Password Request" (consistent message and response time) | Checked: `server/recovery-routes.test.ts` "answers the same, in at least the same time"; `server/recovery.test.ts` "answers every identifier the same way" |
| Ten requests per requester address in 15 minutes (refused), three messages per account an hour (dropped silently: no inbox flood, no signal); 20 reset or start attempts per address in 15 minutes; a forgotten-password request never locks an account, and a reset clears a sign-in lock | OWASP "Forgot Password Request" (rate limits per account), "URL Tokens" (rate-limit token guessing), "Account Lockout"; NIST 3.2.2 | Checked: `server/recovery.test.ts` "limits requests", "ends every session, clears a sign-in lock" |
| The new password typed twice and checked by the sign-up rules (length, common passwords, the handle); stored with scrypt; every session of the account ends; the person is not signed in by the link; every address and the account's notices are told | OWASP "User Resets Password" (twice; policy; secure storage; notify; no automatic sign-in; end sessions) | Checked: `server/recovery.test.ts`; `browser/tests/recovery.spec.ts` "forgot password" (the other device signed out; the old password refused, the new one accepted) |
| An email address (any ordinary address, Gmail included) is used only after its confirmation by a one-time link or a six-digit code (scrypt-hashed, five tries, 30 minutes); a phone number by a six-digit code (10 minutes); wrong codes counted per person across new codes (ten an hour); up to three email addresses | NIST 4.2.1.2 (a new address confirmed with a code; at least two addresses; text codes 10 minutes); NIST 3.1.3.2 (secrets under 64 bits rate-limited; a new secret does not reset the count); NIST 3.1.2.2 (short secrets salted and hashed with a password hash) | Checked: `server/recovery.test.ts` "addresses" group |
| A newly confirmed email starts nothing for the protection delay (72 hours); it hears of everything at once | OWASP "Account Recovery After Suspected Compromise" (do not rely only on recently added recovery details) | Checked: `server/recovery.test.ts` (a recovery request to an address inside its delay sends "cannot be used for that yet") |
| Changing an address keeps the old one until the new one is confirmed, then tells the old one; removing one tells the removed one; adding, changing or removing needs the account's strongest confirmation | NIST 4.6 (subscribers update their addresses at AAL2; notices to every address); NIST 4.1.2.1 (notice through a channel independent of the change) | Checked: `server/recovery.test.ts` "a change keeps the old address", owner isolation |
| Account recovery needs an email link and a second proof obtained differently: a saved code (80 bits), a code a recovery contact issued, or the password (not one a reset set within the protection delay: a reset proves only the mailbox the link proves); five wrong proofs end the link, each try taken before its proof is checked; one proof at a time; one open recovery at a time | NIST 4.2.2.2 (at AAL2: two recovery codes obtained by different methods, or one recovery code and a single-factor authenticator); NIST 3.1.3.1 (email is never an out-of-band authenticator, but issued recovery codes by email are allowed) | Checked: `server/recovery.test.ts` "account recovery by email" group |
| Nothing is granted when a recovery starts; it waits the recovery delay (72 hours); every signed-in device, every confirmed address and every recovery contact is told; any of the account's passkeys (with a fresh confirmation) or a recovery contact (with theirs) can cancel it; the "ready" link goes out once when the wait ends | NIST 4.2.3 (every recovery notified); NIST 4.2.1.3 (recovery contacts, viewable and manageable); NIST 4.6 (to every non-postal address, with what to do if disputed) | Checked: `server/recovery.test.ts` "cancelled from a signed-in device ... or by a recovery contact", "waits; its ready link goes out once"; `browser/tests/recovery.spec.ts` "a recovery is cancelled from a signed-in device, and again by a recovery contact" |
| A completed recovery's passkey signs in only (see item 3 above); a saved code it spent is replaced by a new set (none is replaced when the recovery used no saved code), offered on the screen that follows rather than imposed | NIST 4.2.1.1 (a used saved code is invalidated and a new one issued); NIST 4.1.2.1 (binding needs authentication at the account's AAL: a recovery is not that, so the binding gets no authority until a delayed, notified, cancellable restoration) | Checked: `server/recovery.test.ts` "approval authority after a recovery" group; `server/recovery-routes.test.ts` (the session after a recovery; a step-up answered by the recovered passkey refused 409 `authority_restricted`); `browser/tests/recovery.spec.ts` "the recovered passkey is refused an approval, by the sheet and by the server, until its separate delayed restoration completes" |
| The on-chain wallet: a passkey that signs in only is not among the passkeys the wallet set-up uses, the planned signers of a shared wallet, the passkeys offered to be made a signer, or those that may sign a wallet request; adding one as a signer or starting the wallet's recovery for one is refused (`authority_restricted`) | R12 section 4 (a recovered sign-in must not silently gain a signer or vault control) | Read: `server/rail.ts` (every list of passkeys there is `approvingCredentials`), `server/rail-signers.ts` (the two refusals). Checked only through `approvingCredentials` in `server/recovery.test.ts`; no wallet journey was run for it |
| A passkey suspected stolen is suspended at once from another (its sessions end, what it scheduled, a request for authority included, is cancelled); every session can be ended at once from "If something is wrong" | NIST 4.3 (suspend promptly after a compromise is detected); OWASP "Account Recovery After Suspected Compromise" | Checked: `server/recovery.test.ts` (a suspended passkey's request lapses); `browser/tests/recovery.spec.ts` "suspected compromise" |
| A session opened with a recovered passkey cannot acknowledge or dismiss (clear) the notice that warns of the recovery or of any other change to who can act, as a password session cannot, in the person's own workspace or a business workspace (the review's M3); the interface tells such a session, on every page and on every approval sheet, that its passkey approves nothing yet | NIST 4.2.3 (the notification must reach the subscriber); R12 section 4 (nothing silent) | Checked: `server/recovery-routes.test.ts` (401 `stepup_required` on the acknowledgement); `browser/tests/recovery.spec.ts` (the banner and the sheet's note) |
| Every notice outside QED ends with what to do if it was not the person: open QED from a device with a passkey, suspend, end sessions, cancel; a recovery contact can cancel too. A text message says only the event's title and to open QED | NIST 4.6 (clear instructions to a recipient who disputes the event) | Read: `server/delivery.ts` `notifyChannels` |

**Text messages (decision).** NIST SP 800-63B-4 restricts authentication over the phone network (sections 3.1.3.3 and
3.2.9): a number can be moved to another SIM, ported to another network or reassigned to someone else, and a verifier
should weigh such risk indicators; a restricted authenticator needs an unrestricted alternative, meaningful notice of
its risks and a migration plan. Section 4.2.1.2 does allow recovery codes issued by text (10 minutes). QED uses a phone
number for one thing only: short security notices, as a second channel beside email and the notices inside QED. It is
never a factor in a reset or a recovery, and never the only channel. Using it as a recovery factor would let one SIM
swap and one compromised mailbox together start a recovery; that risk would be the owner's to accept, with a provider,
and is not taken here. The interface says this where the number is added.

**Delivery (prepared, not configured).** Every message goes through one adapter (`server/delivery.ts`). In this build
it is the local test outbox: nothing leaves this computer; each message is kept with status `simulated` and shown on the
developer page `/dev/outbox`, which says above everything, and on every message, "Simulated delivery: no email or text
message was sent". The outbox is refused with a public origin (`QED_DELIVERY=outbox` and `QED_PUBLIC_ORIGIN` together
stop the process), where the default is no adapter. A real provider is prepared as an interface and a dispatcher that
sends queued messages once and keeps no text of a sent one (tested with a fake), but none is configured; its adapter
refuses and names the dependency: **for email, a provider account (for example Postmark or Amazon SES) with a verified
sending domain (SPF, DKIM, DMARC), an API credential kept outside source control, and the owner's approval for its cost
and for sending account addresses and security messages to that provider; for text messages, a provider account (for
example Twilio, or MSG91 for India), the sender ID and message templates registered on TRAI's DLT platform for messages
to Indian numbers, a credential, and the same approval.** None is held, requested or created.

**Approvals.** Every approval is the person's passkey signing the exact terms, with user verification required
(`userVerification: 'required'` in the options, `requireUserVerification: true` when verifying; `server/passkeys.ts`):
the device checks that it is the person in whatever way it is set up, and QED receives only a signature, never a
fingerprint, a face or a PIN (NIST 3.2.3 prefers comparison on the device). The words the interface uses for that check
name the platform's methods only as examples, always with the one that is not a biometric (`src/lib/passkey.ts`
`deviceWords`, Security's `unlockWords`, the passkey step at sign-up); they promise no particular method. Standing
instructions already signed run on their own within their limits (the engine needs no new interaction for them); a
recovery takes nothing away from them, and restoring a passkey's authority does not add any.

**The independent review of 24 Nov 2026 (findings H1 to L5).** A read-only review of this branch found eleven faults
that blocked its merge. Each was fixed test-first: the test named was written against the reviewed revision (7888c1b),
seen to fail there, and passes with the fix (`/private/tmp/claude-501/r12-recovery-shots/review/before-fix.txt` holds the
failing run).

| Finding | Fix | Test (failing before, passing after) |
|---|---|---|
| H1: an email link alone finished any open recovery, one the backup path started included | An email link finishes only a recovery the email way started (`via = 'email'`), and only with the finishing key the browser that started it was given (144 random bits; its SHA-256 kept in `recovery_requests.secret_hash`); a backup reference finishes only a backup recovery; a wrong key takes one of the link's five tries. A recovery not finished within seven days of its wait ending lapses (`cancelled_by = 'expired'`). The v7 migration closes an open recovery from before v4 with no reference secret, which nothing could finish | `server/recovery-review.test.ts` "a via='codes' recovery finished by an email link is refused", "finishing needs the key the starting browser was given: without it, or with another, nothing is registered", "a recovery not finished within its window lapses: it can no longer be finished, and a new one may start", "a backup recovery past its window is refused by its reference even before the tick closes it" (written after its check, then seen to fail without it); `server/recovery-migration.test.ts` "review H1: an open v6 recovery with no reference secret, which nothing can finish, is closed by the migration"; `browser/tests/recovery.spec.ts` (the finishing link opened in another browser asks for the key and makes no passkey; added with the fix, not run against 7888c1b) |
| H2: a session opened with a sign-in-only passkey passed every guard written as `authMethod === 'password'` | One rule (`weakSession`, `server/api.ts`) holds a password session and a sign-in-only passkey session alike, the passkey's authority read at each request (`Session.signinOnly`): pausing or revoking a protective instruction, cancelling its runs, resuming an instruction and switching protective selling off need a passkey that can approve (`authority_restricted`); what such a session prepares is recorded as `signin-passkey` and said in what the passkey signs; a payee it adds is told to every member | `server/recovery-review-routes.test.ts` "H2: a sign-in-only passkey session cannot pause, revoke or resume protection, nor switch protective selling off", "H2: a payee and a payment prepared in a sign-in-only passkey session say so in what the passkey signs, and the payee is told" |
| M1: after a reset, the reset password confirmed new saved codes, removing addresses, cancelling a recovery, and adding a passkey after which resets were refused | For the protection delay after a reset (`passwordHeldUntil`) the password confirms none of: new saved codes, adding or removing an address, cancelling a recovery, stepping down as a contact (`authority_restricted`, saying until when); nor is it a second proof beside an email link (`password_reset_recently`). Passkeys that sign in only no longer stop a reset (only one that can approve does), and a reset stops any request for approval authority then waiting. The Security page states the hold | `server/recovery-review.test.ts` "new codes, an address added or removed, and a recovery cancelled are refused with a password confirmation while the hold stands", "an account whose only passkeys sign in only can still reset its password, and the reset stops a pending request for authority" |
| M2: a recovery contact inside the protection delay of their naming could stop recoveries | Only a contact in force (accepted, and past that delay) stops anything, as for issuing a code | `server/recovery-review.test.ts` "refuses a contact whose naming has not yet taken effect" |
| M3: the wallet's notices of a change to who can act are warnings, which any session could dismiss; the acknowledgement rule read the workspace's id, so in a business workspace any password session cleared them | One rule (`maySettleSecurity`) for acknowledging and dismissing such a notice or its escalation: a session opened with a passkey that can approve, or a fresh confirmation with one; in the person's own workspace, also any session of a person with no passkey at all. Never a password or sign-in-only session of a person who has a passkey, and never one in a business workspace | `server/recovery-review-routes.test.ts` "M3: in the person's own workspace, a password session and a sign-in-only session neither acknowledge nor dismiss a notice of who can act", "M3: in a business workspace, a member's password session neither acknowledges nor dismisses a notice of who can act" |
| M4: with no delivery adapter the pages said a message was on its way | With `QED_DELIVERY=none`, a reset request, a recovery link and a new address are refused before anything is looked up (503 `delivery_unavailable`, alike for every identifier), in words that say what works instead; the pages say the same, offer no email way, and put the saved codes first (`shared/delivery-words.ts`) | `server/recovery-review.test.ts` "a reset, a recovery link and an address to confirm are refused, saying why and what to use instead"; `shared/delivery-words.test.ts`. The pages in that mode were photographed on a local stack with `QED_DELIVERY=none` at 1440 and 390 wide in both themes and measured for contrast (0 below threshold); no journey runs them |
| L1: links and codes stayed in `outbound_messages.body` (the developer page, backups) while this section said only hashes were kept | Each message records its token and a copy of its text without the link and the code; when the token is used, replaced or expires, that copy replaces the text (`redactSpent`, at each spend and replacement and on the engine's tick). The claims above say what is kept | `server/recovery-review.test.ts` "redacts the reset link when used, an earlier link when replaced, a recovery link when it lapses, and a confirmation code when used" |
| L2: anyone can make the owner's live link stop working by asking for a new one | Not changed; stated below | None |
| L3: the v7 migration gave full authority to a passkey a v6 recovery had registered within the protection delay | Such a passkey signs in only after the migration (reason `recovery`), the hold a recovery leaves is set, and the person's security history says why (`authority-limited-by-upgrade`); older recovered passkeys, and all others, keep full authority | `server/recovery-migration.test.ts` "review L3: a passkey a v6 recovery registered within the protection delay signs in only after the migration; an older one keeps its authority" |
| L4: the backup start answered without the time floor, and hashed a typed password only on an account that had one | The route answers no sooner than the same 450 ms floor, timed to the end of the password hash; a typed password is hashed on every path, against a stand-in where there is none | `server/recovery-review-routes.test.ts` "L4: the backup recovery start takes the same time floor for an account that does not exist" (the floor; the stand-in hash was read in code, not timed) |
| L5: a wrong proof was counted from the tries read before the password was hashed, so a burst counted as one | A try is taken before the proof is checked, in one statement (`attempts = attempts + 1 ... WHERE attempts < 5 RETURNING attempts`): at most five proofs are ever checked against one link (a typed code likewise) | `server/recovery-review.test.ts` "eight wrong passwords sent at once leave the link dead after five, as one at a time would" |

Not done, or residual:

- An account whose only key is a password is as safe as that password and its email: whoever controls the mailbox can
  reset the password and sign in (to look and to prepare). A passkey added after that signs in only until its authority
  is restored after a wait; on such an account no other passkey or device exists to stop that request, so the notices, a
  recovery contact and a later reset (which stops a waiting request) stand in the way. Adding a passkey and a contact is
  the remedy the interface urges.
- The hold after a reset (M1) lasts the protection delay. After it, a reset password confirms as before: someone who
  holds the mailbox unseen for longer than that, while every notice of the reset reaches the account's other addresses
  and phone, can then change what the hold protected. During the hold, a recovery under way can be stopped only by a
  recovery contact or a passkey that can approve, so an account with neither cannot stop one for that time. A sign-in-only
  passkey added during a hold keeps signing in after a later reset; its request for authority is stopped by that reset
  and would have to wait again.
- The finishing key of a recovery by email lives in the browser that started it (it is also shown once, to keep, for
  finishing on another device). A person who starts on a device and then loses it starts again.
- Anyone who knows an account's handle or address can make its live reset or recovery link stop working by asking for
  another (review L2), up to three times an hour per account; the owner receives each new link, and an older one says
  that a newer one was sent. A denial of service only: no link reaches anyone but the account's own addresses.
- After a recovery the old passkeys stay as they were: a recovery could be someone else's, and suspending the owner's
  real passkeys would lock the owner out. A person who recovered because a device was stolen can suspend its passkey
  only once their new passkey has authority, or from another device that has one.
- **Open question for the owner (M2).** A recovery contact in force can stop every recovery and every request for
  approval authority of the person who trusts them, as often as they like: nothing limits it. A contact acting against
  the person can keep them out until the person ends the contact, which needs a passkey that can approve, which a person
  who has lost every passkey does not have; two contacts who disagree can likewise deadlock a recovery. Whether to limit
  a contact's stops (a number, a cooling period, a quorum of contacts, or the person's own email link overriding a stop
  after a longer wait) is a policy decision; none was invented here. The backup path without email still needs a
  contact or the password.
- The local test outbox shows every simulated message to anyone who can open the local page; it exists for this computer
  only. A link or code there that still works stays in the kept text (and so in the database, encrypted at rest only as
  the database is) until it is used, replaced or expires; then it is removed from that text (L1).
- The 450 ms floor equalises the answers' time, the backup start's included since L4; it was checked to hold, not
  measured statistically for leaks.
- The journeys use a virtual authenticator; no real phone, security key or screen reader was used.

### 8f. The R13 security review (24 Nov 2026)

An agent-assisted review of the server and the wallet service, not an external audit: `docs/SECURITY-REVIEW-R13.md`.
Thirteen findings were confirmed on disposable stacks and fixed, each with a check in `scripts/security.ts` (R01 to R13)
that failed on `99dd3e4` and passes after its fix (119 of 119). One confirmed finding is **not fixed** and qualifies
claims above: any web page that can reach the local chain's Anvil (a page on another local origin, or a browser without
Local Network Access gating) can use its JSON-RPC over a WebSocket, which CORS does not cover, and over HTTP after DNS
rebinding, since Anvil checks neither Origin nor Host. It can then act for any owner account by impersonation. So
`--no-cors` does not make the chain unreachable from web pages (G-C4), and section 8's "owned by its own passkeys … the
chain checks it again" holds only against clients that do not use the chain's RPC directly. The remedy is the owner's
choice (the review's F-14). Fourteen leads that were not reproduced are listed there, with what would confirm each.
Superseded the same day by 8g: F-14 is fixed, and twelve of the fourteen leads were confirmed and fixed.

### 8g. The R13 security review, second pass (24 Nov 2026)

Same kind of work as 8f (agent-assisted, not an external audit), on disposable local stacks only. Detail and evidence:
`docs/SECURITY-REVIEW-R13.md` section 8.

- **F-14 fixed: no web page can reach the local chain.** Anvil 1.7.1 always opens a TCP listener (an empty `--host` is
  refused) and checks neither Origin nor Host, so the wallet service now puts that listener on a port browsers refuse
  (the Fetch standard's "bad ports", which govern fetch, navigation and WebSocket under any host name) and talks to
  Anvil only over its IPC socket, in a folder only this user may enter (0700, the socket 0600). The vendored release's
  clients keep their address, which `chain/rail/chain-socket.ts` answers over the socket; Node's own fetch refuses those
  ports too, so nothing falls through to the listener. The Security Lab's ephemeral chains get the same. The scripted
  economy's chain (lead L-13) also listens only on such a port, but the release's services start with an allowlisted
  environment that only an address reaches, so the run's port is a guarded front (`startChainGuard`): it answers local
  programs and refuses any WebSocket upgrade, any request with an Origin, Sec-Fetch-Site or Sec-Fetch-Dest header, any Host other than
  127.0.0.1 or localhost on that port, and anything but a JSON POST. Checked from Chrome 158 (`scripts/security.ts` R14: before, a WebSocket from another
  local origin moved the clock by two years and a rebinding request read the chain id; after, all refused) and in
  `chain/test/anvil-cors.test.ts`. G-C4 and section 8's "the chain checks it again" hold again for web pages.
  **What remains:** a local program that is not a browser (curl, cast) and any other account on this computer can still
  reach the listener, and Anvil asks no credential; a browser started with its port blocking overridden
  (`--explicitly-allowed-ports`) can too. Only a chain with no TCP listener, or one in its own network namespace or
  container, closes that. Other browsers than Chrome were not tried (NOT VERIFIED; they follow the same standard).
- **Leads (8f):** confirmed and fixed, each with a check that failed before its fix and passes after: L-01 one person's
  share of the wallet service (R16), L-02 a refund held off by the other party (R17), L-03 a business's own number of
  signatures on vault requests (R18), L-04 the other party's escrow figures (R19), L-05 another member's model proposals
  in evidence (R22), L-06 another member's proposals dismissed or drafted (R23), L-07 the model for everyone together
  (R20), L-08 one workspace's vault activity in every session's events (R21), L-09 tenant scans and an unchecked id
  (R24), L-10 a business's notices of who can act (R25), L-11 an email recovery hidden by a backup one (R26), L-12 a protective sale
  stopped by a weak session (R15), L-13 the economy chain's CORS (`chain/test/economies.test.ts`). L-14 (the throttle
  against heavy reads) was measured, not confirmed: `/api/home` and the 336-hour market history answered in under 5 ms
  on the test stack; a large book was not built (NOT VERIFIED for one).
- **Recovery fixes H1 and H2, read again:** H1 holds (each way finishes only what it started: a single-use link, a
  144-bit finishing key kept as its hash and compared in constant time, every state re-checked inside the transaction).
  It was not complete: a recovery the backup path started beside an email one hid it, so the email one could not
  finish (L-11; an email link now finds its own recovery, and the backup one keeps its own reference). H2 holds for the routes it covered (pausing, revoking, resuming, the stop switch), and was not
  complete either: asking again for a protective run's approval, or withdrawing it, had no guard (L-12, now guarded).
- **Workspace keys (P6), decided: derivation from one sealed master stays for this build.** The derived keys (the
  service's deployer, agent, guardian and relayer for each workspace) hold no owner authority: owners are passkey
  accounts, and what an agent key can do is bounded by owner-signed mandates and the co-signer. One process holds and
  uses every workspace's keys, so separate secrets sealed under the same key-encryption key would not narrow what a
  compromise reaches, and re-keying would change every existing workspace's agent and guardian addresses, which only an
  owner-approved, delayed change on the chain could repair. A hosted key service would change this: one non-exportable
  key per workspace and role, a signing record per use, access granted per key, and a key destroyed at erasure, so that
  one workspace's keys can be revoked or erased alone, which derivation cannot do (an erased workspace's keys stay
  derivable while the master exists).
- **The deny list (F-033, P7)** now has a source and a date and a recorded way to change it (`chain/rail/denylist.ts`):
  the list in force is the wallet service's own, or the built-in test entry, labelled "not a sanctions list"; every
  change states its source and date and is recorded first in a hash-chained history. No sanctions list is loaded; that
  is the owner's decision.
- **Wording:** "protective selling keeps running" overstated a pause made without a device: a protective instruction
  set to ask first still waits for a passkey approval before each sale (`server/policy.ts`, run-approved). The sign-in
  page, both pause notices, the pause sheet and the protection screens now say so.
- **Two contract claims from `docs/standards/SCSVS.md` section 4, checked:** QEDOwnerAccount's `withdraw`, `ringFence`,
  `unpause` and `setGuardian` are "not guarded" in the sense of not time-locked: they run at once, but only through
  `execute` with the threshold of unfrozen Members (a frozen Member's approval is refused; `protect` cannot reach them).
  No path moves money below the threshold; the delay is an owner's open question (`chain/accounts/README.md`). The
  bounty board does let any opener name any judge, and a judge that keeps the pool strands that bounty's money for
  good (nobody gains it); QED's wallet service uses only the four bounties it opens with judges built from the
  release's bytecode, and refuses any other.

### 8h. R13 hardening: the ASVS 5.0 pass (24 Nov 2026)

Same kind of work as 8f and 8g (agent-assisted, not an external audit), against OWASP ASVS 5.0.0, Level 2 everywhere it
applies and Level 3 for authentication, sessions, authorization and cryptography. Every change is tested in the unit
suite, and the ones a running stack shows are checked by `scripts/security.ts` X01 to X08 (with X03 beside R11). Method,
results and the requirements left open, with why: `docs/SECURITY-REVIEW-R13.md` section 9; each requirement's status and
evidence: `docs/standards/ASVS-5.0-L3.md` ("Hardening pass of 24 November 2026") and `asvs-5.0-l3.json` (`hardening`).

**What changed.**

- **One transaction per changing request** (brief item 2; X08, `server/request-tx.test.ts`). A synchronous handler runs in
  one `BEGIN IMMEDIATE ... COMMIT` (`server/api.ts`, the dispatcher): a failure part-way, a full disk included, leaves
  nothing of the request, and the API answers 507. Before, PATCH /api/profile saved the profile and then its audit entry
  separately, and a refused second write kept the first (the test's seeded twin shows it). An asynchronous handler (one
  that waits on a passkey check, a password hash, the wallet service or a model) keeps each write phase after a wait in a
  transaction of its own; the ones that did not (sign-in, registration, a step-up, vault signers and recovery, escrow
  refunds and timeouts, model drafts, quotes) were fixed. Rate-limit counts are **kept apart**: `Db.keep` writes the count
  at once and, if the request's transaction rolls back, writes it again after the rollback, so a refused or failed attempt
  still uses up its allowance. `docs/PERMISSIONS.md` says for each route which of the two it is.
- **A new passkey cools off for 24 hours** (brief item 3; RISK-068, Q-062; X05, `server/cool-off.test.ts`). A passkey added
  beside another cannot, until 24 hours after it was added: approve a request above ₹10,000 (`NEW_PASSKEY_LIMIT_PAISE`,
  checked when it signs: `server/approvals.ts`), loosen a protection (anything the protection delay governs, plus naming or
  ending a recovery contact, new saved codes, adding or removing an address, a password change, removing or allowing
  again another passkey, giving a passkey authority at once), or add a signer (vault set-up, signers, thresholds, recovery
  keys and recoveries; such a passkey is not made a signer either). Meanwhile any older passkey with full authority removes
  it **at once**, not after the 72-hour delay; the person is told when it is added (the notice states the limits) and when
  it is removed. A session's confirmation now records which passkey gave it (`sessions.stepup_credential_id`, v8 part r), so
  the limit follows the passkey, not the session. The account's first passkey has none (there is no older passkey to remove
  it; one added by an account that had only a password keeps D-094's rule, RISK-076). Recovery's own delays are unchanged.
- **Grants wait; narrowing is at once** (brief item 4; Q-048; X04, `server/grants.test.ts`). Adding a member as an
  operator, approver, admin or owner, or raising a member's role, is scheduled behind the protection delay
  (`server/workspaces.ts` requestMember, kind `grant-member`), cancellable by any member who may sign, and told to every such
  member, the person who asked, that person's recovery contacts and the person to be given it; when it falls due it is
  applied only if whoever asked may still give that role. A viewer is added at once. Lowering a role or removing a member
  applies at once and withdraws a grant waiting for them (new routes `/api/workspace/members/:id/role` and `/remove`). A
  workspace keeps one owner. Workspace shows the grants waiting, with their cancel, and every member's open page is told
  when one is asked for, applied or withdrawn (a `workspace` event to each member's own stream).
- **Resuming needs a fresh passkey** (brief item 4; Q-059; X03). Resuming a paused instruction, like clearing a pause of QED,
  now needs a passkey confirmation within five minutes from every session, one opened with a passkey included, by a passkey
  past its cool-off.
- **The page's Content-Security-Policy** (X01, `server/headers.test.ts`, `browser/tests/csp.spec.ts`). The page gets a
  policy made for its one response: `script-src 'nonce-…'` only (a script runs only with the nonce, or imported by one that
  has it; not `'strict-dynamic'`, under which Chrome let a script added by script run, as the spec's first run showed),
  `style-src 'self' 'nonce-…'` with no `'unsafe-inline'`, `report-uri /api/csp-report`; Trusted Types are reported, not yet
  enforced. The build writes a placeholder in every nonce attribute (`vite.config.ts` html.cspNonce) and the server puts the
  response's nonce in its place; the page is never stored (`no-store`). API answers carry `default-src 'none'`. Every main
  screen ran in Chrome under it with nothing blocked or reported. Violation reports are taken by `/api/csp-report` without the
  interface's headers, limited to 30 a minute per address and 300 for everyone, at most 16 KB, and written to the log.
  Permissions-Policy now switches off every powerful feature the wallet does not use. Only the interface's own kinds of file
  are served (any other is 404); source maps are built unreferenced and never served; every text type names its charset.
- **Sessions** (`server/session-hardening.test.ts`, X07). 1 hour idle and 24 hours in all, everywhere (NIST SP 800-63B-4
  section 2.2.3 at AAL2; was 12 hours and 7 days locally); at most 10 per person, a sign-in beyond that ending the least
  recently used, said in the history; a sign-in ends the session the browser presented; the CSRF token is compared in
  constant time; signing out sends `Clear-Site-Data: "cache"`, is recorded, and drops the page's in-memory prices and handed
  question; the operator ends one person's or everyone's sessions with `node server/main.ts sessions end <handle>|--all`.
- **Passwords**: built from the service's name, its parts, or the person's own handle or name is refused (`CONTEXT_WORDS`
  in `server/auth.ts`); five wrong passwords now tell the person at once, on every confirmed address.
- **Recovery codes made before v3** (salted SHA-256) are put under scrypt by the v8 step, part (r): scrypt of the stored digest
  (`algo` `scrypt-sha256`). The same codes keep working; nothing a person holds changes.
- **A cost-aware throttle** (lead L-14; `server/guard.ts`, `server/guard.test.ts`). Each address and each signed-in person
  may hold the API's thread for at most 20 seconds of every minute (a third of it); past that, 429 `too_costly` with
  Retry-After. The request count (1,500 a minute per address) stays.
- **Refusals logged and alerted** (X06). Each 400, 401, 403, 413, 415, 421 and 429 is one `refused` line in the operational
  log with its status, code, route, address and person (never the query or the body), at most 20 a minute per address and
  code, then a count of the rest; 500 refusals in five minutes open an incident (`security-refusals`), shown in Protect.
- **Outbound calls** no longer follow redirects to another host or to plain http (market data: the same host over https,
  three hops at most; the wallet service, the paper services and the off-site copy: none), and a provider's answer is read
  only up to its size limit. A fault of the wallet service is logged and the person told plainly, without its words, except
  the few that say what to do and name nothing inside it (the chain still starting, a workspace still being made, a part
  this chain lacks); a model client's failure likewise (its error output goes to the log).
- **Downloads** are named by the server and sent as RFC 6266 asks (`filename` and `filename*`).
- **Secrets that must never appear**: `node scripts/never-appear.ts` fails if either published honeypot key of the
  approved release appears in any file of this repository, matching keys by their public addresses so the list holds no key
  (`server/never-appear.test.ts`; run 24 Nov: 4,991 files, 7,450 candidate values, 0 hits; the git history NOT VERIFIED).
- **Inventories generated from the code**: `docs/PERMISSIONS.md` (every route, its session, least role and further checks)
  and `docs/crypto-inventory.json` with `docs/CRYPTO.md` (every cryptographic primitive and the files that use it); unit
  tests fail when either drifts from the code.

**Browsers** (ASVS 5.0 V3.1.1, V3.7.5). QED needs a browser with: WebAuthn with user verification (passkeys; without it
the interface says "This browser cannot make passkeys" and offers no passkey ceremony, a password account can still sign in
and read, and nothing can be approved, since every approval is a passkey signature),
Content-Security-Policy Level 3 nonces, SameSite cookies, the Fetch metadata headers (Sec-Fetch-Site; a browser without them
is still refused cross-site by the Origin check), and `Clear-Site-Data`. Hosted, it also needs TLS 1.2 or later with HSTS
(sent on every response under HTTPS: `max-age=31536000; includeSubDomains`). Tested in Chrome; Firefox and Safari are run
only by the cross-browser journey (NOT VERIFIED for the new policy).

**Limits** (V2.1.3). Per address: 1,500 API requests a minute; 20 s of the API's thread a minute; 30 sign-ins and 60
passkey sign-ins in 15 minutes; 20 sign-ups an hour; 10 recovery starts an hour; 10 reset and 10 recovery-link requests in 15
minutes; 30 violation reports a minute. Per person: 20 s of the thread a minute; 10 sessions; 8 wrong retyped passwords in
15 minutes; 10 password changes or removals in 15 minutes; 6 new addresses an hour; 10 wrong codes an hour; 3 reset or
recovery links an hour; 480 vault requests an hour and 4 vault set-ups a day; 20 certificate checks a minute; 30 model
questions an hour. Per workspace: the vault requests, the model's daily and monthly budget, 500 payees, 60 chain
comparisons an hour. For everyone: 600 model questions an hour and 4 at once; 60 certificate checks a minute; 300 violation
reports a minute. Each is in the code named beside it in `docs/PERMISSIONS.md` ("rate limit") or `server/guard.ts`.

**Authentication controls** (V6.1.1, V6.1.2, V6.2.8). Five wrong passwords lock **the password** for 15 minutes; passkeys
still sign in, so a stranger who knows a handle can hold the password but not the account; the person is told. Sign-in,
reset and recovery answer alike, and in the same time, for an unknown handle. Context words: `CONTEXT_WORDS` in
`server/auth.ts` (qed, qedwallet, wallet, paperbank, paper, rupee, rupees, meridian, household, passkey, webank,
fintechathon) and the person's handle and name, with common digit-for-letter swaps undone. A password is NFKC-normalised
before it is hashed, at enrolment and at sign-in alike (NIST SP 800-63B-4 section 3.1.1.2): a documented exception to
V6.2.8's "exactly as received".

**Sessions** (V7.1.1, V7.1.2). 1 hour idle, 24 hours in all (above); a long-lived local fixture sets its own and says so.
Everything that moves money or changes authority needs a passkey assertion made for it or within five minutes, whatever
the session's age. At most 10 sessions per person; the eleventh ends the least recently used.

**Authorization** (V8.1.1 to V8.1.4). The permission table is `docs/PERMISSIONS.md`, generated from the routes; roles and
what each may do: `server/workspaces.ts`. Field-level rules: every member of a workspace reads all of its records, except
that a model's proposals and their evidence are the asker's (an owner or admin sees all), an escrow party sees only its own
step's words, and only the person sees their own security settings; a viewer changes nothing. Contextual attributes used in
decisions: the passkey that confirmed and when (five minutes; its 24-hour cool-off), the amount (limits, bands, ₹10,000 for
a new passkey), a payee's age (the new-payee wait), the client address (rate limits and the thread budget), the time (delays
and expiries), the workspace and role. Not used: location, time of day, device posture.

**Communications** (V13.1.1 to V13.1.3). Outbound, all over TLS with Node's defaults (TLS 1.2 or later): market data from
api.coindcx.com and public.coindcx.com, portal.amfiindia.com, api.mfapi.in, data-api.binance.vision (also its WebSocket
stream), api.frankfurter.dev, markets.newyorkfed.org and ws-feed.exchange.coinbase.com (none in presentation mode); the
model provider when configured (180 s, 4 calls at once, refused beyond); an off-site copy when configured. Internal: the
wallet service on loopback HTTP with a bearer token (15 s, 2 minutes for a vault set-up), which reaches its chain only over
an IPC socket; the paper services on loopback. Each outbound fetch has its timeout (5 to 30 s), is not retried on the
request path, follows no redirect to another host, and fails closed (the screen says the source did not answer). No user
supplies a destination.

**Secrets** (V13.1.4). The KEK (rotate by `rewrap`, when a person with access leaves, or yearly); data keys (rotated when due,
`backup.ts expire`); the wallet service's bearer token and master secret (rotation by replacing the file and restarting:
manual, NOT automated); co-signer keys (per version); the adviser's token when used; a model API key when used (the
provider's own rotation). Sessions and link tokens expire on their own.

**Data classification** (V14.1.1, V14.1.2). Secret: keys, tokens, password and code hashes (never logged, encrypted or hashed
at rest, mode 600). Personal and financial: the person's records, payees, addresses (in the database of mode 600, sealed in
backups and exports; logs carry route paths and ids, never bodies; retention by `server/records.ts`). Third-party: payee
names and handles, counterparties (as personal; sent to a model only when the person asks). Public: prices, published
evidence. `docs/ENCRYPTION.md` section 1 lists every store.

**Components** (V15.1.1, V15.1.3 to V15.1.5). Remediation time frames for a vulnerable dependency: critical 7 days, high 30,
medium 90, low at the next update; routine updates monthly; `npm audit` before each release (24 Nov: the app 0, the wallet
service 2 moderate, esbuild through tsx, not reachable). Risky components: the vendored release (pinned by hash), the
optional GPL-3.0 zero-knowledge tier (off by default), the model command-line client (a child process with an allowlisted
environment), Anvil (a test chain, F-14), `@simplewebauthn` (security-critical). Dangerous functionality: spawning the model
client, the chain's RPC, recovery, every change that loosens a protection, signature verification; each has its guard named
above. Expensive functions and their bounds: model questions (180 s, 4 at once, budgets), certificate checks (600,000
cells, 20 a minute), the look-alike check (bounded edit distance, 500 payees), vault set-ups (4 a day), and every request's
share of the thread (20 s a minute).

**Logs** (V16.1.1). Operational log: one line per event (`server/log.ts`, JSON with `QED_LOG_FORMAT=json`), standard output
for information (`refused`), standard error for warnings and errors (`csp-violation`, `storage fault`, `wallet service fault`,
`request failed`), redacted; written to `data/api.log` and `data/engine.log` by the local start, to the host's log store when
hosted; kept as the host keeps them. Records in the database: `audit` (append-only), `security_events` (what the person is
told), `access_log` (sign-ins, step-ups, exports, other members' reads), `incidents`; kept by `server/records.ts`'s schedule.
The wallet service keeps its own decision records and log (`chain/rail`).

**What this pass could not meet on this computer, and why** (detail per requirement in the ASVS file): HSTS preload, a
publicly trusted certificate, OCSP stapling, Encrypted Client Hello, forward-secret cipher suites and TLS between services
(**need hosting and TLS**); the `__Host-` cookie prefix and `Secure` on the plain-HTTP local build (**need TLS**: the hosted
profile already uses both); logs shipped to a separate system, memory encryption, an HSM (**need hosting**); a top-3,000 and
a breached-password list (**need a third-party password corpus added as data: the owner's decision**); per-message signatures
between services and mutual TLS (**hosting design**); retiring the operator's review-account password script (**the owner's
review process**).

### 8i. R13 owner options: two devices, a guardian, a time-lock, and the bounty board's judges (24 Nov 2026)

Built as settings, each off by default (or at the earlier behaviour), so the owner's decision is a setting. Research code,
not audited. Wallets set up before this build keep their owner account's bytecode and gain none of it; the Security screen
says so (`chain/accounts/README.md`, "R13: owner options").

- **Require two of your devices** (D-l): a household raises its wallet's thresholds to 2 and 2 under Security; QED then asks
  the person for two different passkeys per approval, one device per round, and sends both assertions; the chain counts them.
- **Guardian** (D-m): a passkey of the person's recovery contact, set or removed only behind the wallet's delay. While one is
  set, a recovery starts only with its co-signature over that very recovery (`startCosignedRecovery`), given by the contact
  in their own session; a frozen passkey cannot cancel a co-signed recovery.
- **Time-lock**: chosen at set-up; while on, `withdraw`, `ringFence`, `unpause` and the vault's `setGuardian` wait the
  delay like the guarded calls. On applies at once; off waits the delay.
- **Bounty board**: `open` accepts only judges whose runtime code hash is allowed (on the wallet's chain, the judges it
  opens). Its deployer may change the list for later bounties only.
- **Least privilege** (`docs/LEAST-PRIVILEGE.md`): the co-signer process no longer receives any key setting; the wallet
  service hands it its own keys over a pipe.

New residual risks, in order:
1. **A misused sentinel and a guardian together.** If QED's service key freezes every member while the guardian co-signs a
   recovery made with a stolen code, no member can cancel it, and the code's holder gets a seat after the recovery delay.
   Before the guardian existed a frozen member kept its veto over every recovery. It needs three things at once: the
   service key misused, the guardian's co-signature, and a recovery code (`chain/accounts/test/Guardian.t.sol`).
2. **A guardian who colludes with a code thief** gets the thief a seat unless an unfrozen member cancels within the
   recovery delay (`test_a_colluding_guardian_and_code_thief_are_stopped_by_any_unfrozen_member`).
3. **An unreachable guardian** blocks every recovery until the members replace it, which needs the admin threshold; a
   household that has lost every device by then cannot recover the wallet.
4. **Two devices, exactly two passkeys**: losing one leaves only the veto (cancel, stop the agent) until a recovery adds
   another passkey, which waits the recovery delay. The screen states this trade-off.
5. **The time-lock's costs**: resuming after a pause waits the delay (the agent stays stopped), funding an earning job from
   the vault is refused while it is on, and a thief holding the admin threshold can turn it on at once against the owner's
   own withdrawals (the same power as raising a threshold, which is also immediate).
6. **The account's WebAuthn checks are now written in the account** (to stay under EIP-170), reproducing OpenZeppelin
   5.6.1 `WebAuthn.verify`'s checks with the precompile as the only signature check. A differential fuzz test against
   OpenZeppelin's own, unmodified function (1,000 runs, plus all 256 flag bytes) and the 26 verifier tests agree; nobody
   outside this work has reviewed it.
7. **The bounty board's deployer** can allow a judge that strands money for bounties opened later; it cannot change a
   bounty already open. A funder should check a bounty's judge before funding it.
8. **Partial two-device signatures** are kept in the database until the second device signs; one whose approval lapses is
   left there (assertions over public digests, no secret).
NOT VERIFIED: real authenticators for the two-device rounds (Chrome's virtual authenticator only); the guardian's
co-signature in a browser (server tests against the fake vault service and the rail's test on a real chain only).

### 8j. The independent review of the R13 fixes (25 Nov 2026): open findings for the owner

A reviewer other than the fixes' author read the merged revision `1cb35ad`. Fixed before the release: M1 and M2 (the
entrypoint and the tsx cache, docs/LEAST-PRIVILEGE.md), M3 in part, and wording that promised a way out of an all-frozen
wallet. H1 and H2 were then fixed and re-verified (below):

- **H1 (High).** With a guardian set and every passkey frozen, a co-signed recovery never finishes and nothing can unfreeze a
  passkey (that needs passkeys that are not frozen): a permanent hold on the wallet. It is what the owner's rule of
  25 Nov ("keep it pending unless the owner has an independent way to challenge it throughout the full waiting period")
  produces while no independent challenger exists. Proposed: let an unspent recovery code other than the one that started
  the recovery cancel it, and let the recovery finish after its full delay when such a code existed throughout.
- **H1, fixed afterwards (25 Nov 2026, `claude/r13-secfix`):** the owner's independent challenger is the vault's sentinel (QED's
  key). It may stop a pending co-signed recovery (`stopRecovery`, at the request of a person who may sign for the vault,
  confirmed afresh with a passkey that is neither suspended nor removed); with every passkey frozen, a co-signed recovery
  finishes after its whole delay only if that sentinel was set and unchanged for the whole wait, else it stays pending.
  Residual: the challenge then rests on QED acting. The Low `_thaw` finding is fixed too (a restart is never earlier).
  `chain/accounts/README.md`, "R13 H1".
- **H2 (High), fixed on 25 Nov and re-fixed after the independent re-check.** One stolen full-authority passkey could
  suspend the person's other passkeys at once (they then cannot sign in, and QED freezes them on chain), or replace the
  printed codes. The first fix gated only a suspension that left a single usable passkey; the re-check found that a thief
  could first remove the owner's newest passkey at once in its cool-off, or (found while fixing) add a passkey of their
  own, and that a cancelled recovery handed a fresh code set to whoever cancelled it. Now every suspension of another
  passkey, the at-once removal of a passkey in its cool-off (without a code it is scheduled and can be cancelled), and new
  codes while unused ones remain each spend one of the person's unused saved codes, which someone holding only a device
  does not have; a cancelled recovery hands out no codes (the one it used stays spent; the person is told to make new
  ones). `server/passkeys.ts` (`suspendPasskeyWithCode`, `removePasskeyWithCode`, `regenerateRecoveryCodesWithCode`,
  `cancelRecovery`); tests in `server/passkeys.test.ts` ("H2"). Residual: a person with no unused codes cannot suspend at
  once (a removal waits the protection delay); an attacker holding a device and saved codes is not stopped by this.
- **H1 (High), fixed and re-fixed.** The vault's sentinel (QED's key) may stop a pending co-signed recovery, and with every
  passkey frozen such a recovery finishes after its whole delay only if the sentinel was set and unchanged throughout
  (QEDOwnerAccount.sol; rail `POST /recoveries/:id/stop`; `POST /api/vault/recoveries/:id/stop`). The re-check found
  that the stop (and the guardian's withdrawal) reused one idempotency key per recovery, so a refused first attempt was
  replayed to every later one; each attempt now has its own key (`server/rail-signers.ts`).
- **Medium, accepted with reasons (the independent reviewer agreed, third round).** (a) A compromised API process can
  drop the owner's challenges, as it could before the H1 fix: in this deployment every owner action, an unfrozen
  passkey's cancel included, reaches the private chain only through QED's wallet service, which the API instructs.
  (b) A thief holding an unsuspended passkey can stop co-signed recoveries through QED until the owner suspends it.
  (c) Removing a recovery contact, the password or an email address takes effect at once on a passkey confirmation, so
  one stolen passkey can strip those account-recovery fallbacks; what protects the owner is a second passkey and a saved
  code (the fallbacks matter only once every passkey is lost). (d) R-4: an owner with no saved code left cannot evict a
  stolen passkey (suspension and at-once removal need a code, new codes need one while more than one passkey is usable,
  and a scheduled removal can be cancelled by the passkey it removes): saved codes now decide every dispute between two
  passkey holders. Sign-up already requires confirming the codes were stored elsewhere; the Security screen warns when
  two or fewer are left and says what to do when none are. Low: a thief's scheduled removals still apply after the
  protection delay unless cancelled (by design; the owner is notified); a thief that is already the only usable passkey
  can spend the codes by cancelling recoveries and then make new ones.
- **Low.** `_thaw` restarts a co-signed recovery at now + the current recovery delay, which can be earlier than its first
  time if the delay was lowered meanwhile; the wallet service does not record `RecoveryRestarted`, so a screen can show a
  stale time until an apply is refused with the new one; a bounty board or an account recorded under an earlier build
  keeps its earlier code; a guardian can spend recovery codes by co-signing and then withdrawing.

None of these can move money in this build: every balance is a valueless test token on a private chain.

### 8k. Account access under R14: ordinary sign-in, the device, and saved codes at the right moment (25 Nov 2026)

The owner's instruction (R14, Priority 1): keep the passkey cryptography and every financial safeguard, and make the
experience around it that of a familiar financial application. The forced saved-codes step at sign-up was the main
complaint. What changed, and why each change is safe, is below; the code names the same rule where it enforces it.

**Five operations, never interchangeable** (`shared/access-operations.ts`, read by the server's comments and by the
screens; `shared/access-operations.test.ts` holds the owner's cells): (1) entering the account; (2) enrolling a device;
(3) approving a protected financial action; (4) recovering account access; (5) recovering authority over the wallet. A
password, Google, an emailed link or code, or a signed-in session never approves money and never becomes wallet
authority: the approval routes still have only the passkey path (a passkey assertion over the hash of the exact terms),
and every rule written for a password session now holds for anything that is not a passkey session
(`server/api.ts` `weakSession`, `server/passkeys.ts` `mayEndStrong`: "not a passkey", so a later way in is weak by default).

**Email and password** (`server/access.ts`, `server/auth.ts`). An account is opened with an email address and a password;
the handle (the public name others pay) is made from the person's name, never from the address, unless they choose one.
- *An address nobody has confirmed reserves nothing.* `users.email_key` is not unique. Opening an account never says
  whether an address is in use (ASVS 5.0 V6.3.8), and nobody can take an address from its owner by typing it first
  (pre-hijacking): a second account opened with the same address is a separate account.
- *Signing in by address* costs one scrypt derivation whether no account, one or several use the address (a "sign-in
  tag": scrypt of the password under a salt made from the address and the installation's random salt, compared with the
  tag of each account opened with that address). Five tries per address in fifteen minutes, counted before any password is
  checked and whether or not any account exists; every account the try did not open counts it as a wrong password, at the
  same five as its handle. A tag is bound to the password hash it was made for, so a path that changed the password and
  forgot the tag stops the address signing in; it never leaves an old password working.
  Residual: two accounts opened with one address lock each other's password sign-in by their own sign-ins (each try
  tests every account's password, so each is counted); passkeys are not affected.
- *Confirmation* goes through `server/delivery.ts`. With the local test outbox it is kept there and said to be simulated.
  With no adapter (`QED_DELIVERY=none`, production today) nothing is written, nothing is said to be sent, the account
  works, and the address is shown as not verified with verifying marked unavailable. No SMTP or HTTP provider adapter
  was added: one needs a provider account, credentials and a verified sending domain (`PROVIDER_DEPENDENCY`), which is
  the owner's decision. Reviewed decision (F4, 25 Nov 2026): the address an
  account was opened with waits the protection delay after its confirmation before it can start a password reset or a
  recovery, as an address added later does, and the owner's devices are told. The first draft made it usable at once; the
  confirmation link needs no session, so someone who controls the mailbox but not the account (an address typed in by
  another person at sign-up, a mailbox given up and taken again) could confirm and reset at once. Test:
  `server/access.test.ts` "F4". What a mailbox alone can do is unchanged (below).

**Google** (`server/google.ts`, `server/google-config.ts`; stand-in issuer for tests `server/oidc-standin.ts`).
OpenID Connect authorization-code flow with `fetch` and `node:crypto` only: state (kept as its SHA-256, used once, ten
minutes), nonce, PKCE S256, a binding value in an HttpOnly SameSite=Strict cookie of the browser that began (login CSRF),
the issuer named in the callback (RFC 9207), and the ID token verified against Google's keys: RS256 only, key of 2048
bits or more, issuer, audience and authorized party, expiry, issued-at, nonce, subject, `email_verified` true. Enabled only
when `QED_GOOGLE_CLIENT_ID` and `QED_GOOGLE_CLIENT_SECRET` are both set; otherwise its routes answer 404 and no button is
rendered. The identity is Google's issuer and subject: an existing account is never signed in to, linked or merged because
its address matches. A Google account QED has not seen opens a new account; adding Google to an account that exists is its
owner's act under Security, with that account's strongest confirmation at the start and again when Google answers. A
session Google opens is an ordinary one, exactly as a password's. Google states no time of last sign-in (no `auth_time`
in its discovery document, read 25 Nov 2026), so "confirmed with Google again" means a new, complete round trip in this
browser, and is never called a re-entry of the Google password. Phone sign-in: no provider exists, nothing is shown; it
would need an SMS provider with sender registration (TRAI DLT for Indian numbers), and a text message would still be an
entry factor only, never a recovery or approval factor (section 8e, "Text messages").

**Enrolling a device.** After sign-up one optional step offers it in the owner's words ("Use your fingerprint, Face ID
or device PIN for faster, more secure access"). The first device: after the account's ordinary sign-in given again in the
last five minutes: the password, D-094, where the account has one; Google confirmed again only on an account with no
password (F5: on an account that has a password, Google is an ordinary sign-in and never stands in for it;
`strongConfirm`, `googleConfirms`; `server/google.test.ts` "F5"). Every further one: only after a confirmation by a
passkey that can approve, and it starts in its cool-off, as before. The page asks the browser whether the device has a
user-verifying check (`isUserVerifyingPlatformAuthenticatorAvailable`) and says plainly when it has none.

**Saved recovery codes, and H2 (8j).** No forced step at sign-up: nothing to tick, nothing to type. They are made in the
same transaction as the account's FIRST device, whichever way it comes: sign-up with a passkey (`finishSignup`), the
first passkey of an account opened with an address, a password or Google (`finishAddPasskey`), and the first passkey made
inside the wallet's set-up (`addFirstPasskey`, the same route). They are shown once on the screen that follows (the device
step, the wallet's first-passkey step or Security: Copy, Download and Continue, with one line on why they matter). A second
device and a completed recovery make none (a recovery spends and replaces one only when it used one, as before R14). A first
passkey added after a password reset signs in only and brings none: a reset proves the mailbox, not the owner.
*The first draft was wrong and the independent review (F1, High) found it.* It made codes optional, and so by H2's own
rule (the only usable passkey may make codes at once) the first holder of a device could mint the tie-breaker. A thief with
a synced passkey, or a session within five minutes of a passkey sign-in, could make codes, add a passkey of his own and
suspend the owner's (suspension checks the code, not the cool-off): the owner could then never suspend, regenerate, remove
at once or start a backup recovery. Now the codes exist before anyone can be a second holder, so every H2 rule applies from
the first device: suspending another passkey, removing a cooling-off one at once and replacing unused codes each spend one,
and with more than one usable passkey and none unused no path makes codes at once. Test:
`server/access-codes.test.ts` "REGRESSION F1" (one passkey, two sessions: the second holder gets no codes and cannot suspend
while the account's codes exist), with the first-device and recovery cases beside it. An account that holds codes and already has a
device keeps the base behaviour exactly; at its FIRST device the set is always replaced (R1, below).
*Correction to the first draft's claim.* It said that one usable passkey means "no second holder, so nobody to decide
between". That is wrong: a synced passkey is one credential with two holders (the owner's devices and whoever got into the
sync account), and so is a session of one credential on two machines. With the codes made at the first device, the accepted
Mediums in 8j (b) and (d) are no worse than before R14: the same codes exist from the same moment, and the sentence in 8j
(d) "Sign-up already requires confirming the codes were stored elsewhere" is replaced by the first-device rule above (the
confirmation box is gone; what protects is that the codes exist and are shown).

**Second review of the F1 fix (what holds now, 26 Nov 2026).**
- *R1 (Medium) closed.* Codes could still be made while an account had no device, with only the password (or Google on a
  Google-only account): whoever made them held the tie-breaker for good, because the first device then made none. Now the
  account's first usable device ALWAYS makes a fresh set in its own transaction and revokes every unused code made before
  it (`finishAddPasskey`), and says on the screen that the earlier codes no longer work. Test: `server/access-codes.test.ts`
  "R1: a password holder makes codes before any device…" (the earlier codes are refused for suspending and for new codes;
  only the new set works). A first passkey that signs in only (after a password reset) still makes none: see R2.
- *R3 (Medium) mitigated.* A first-device set lives only in page memory and is shown once; if it was lost before it was
  saved, no route could make new ones without a code. Now the session that received a set may ask for a fresh set without a
  code (Security: "Show me new codes (the ones made a moment ago were not saved)"), only while the account has exactly one
  usable passkey, no code of that set has been used, and within 30 minutes of its making, and only with that session's fresh
  passkey confirmation. The window is kept on the server (`meta`, key `codes-window:<person>`), bound to the receiving
  session's id, and moves to the new set. Tests: `server/access-codes.test.ts` "R3: …" (works in the window; refused from
  another session, with no fresh confirmation, after 30 minutes, after a code is used, after a second passkey exists).
  Residual: past the window, a lost first set is the F6 situation below.
- *R2 (Medium) OPEN, do not enable email delivery before it is fixed.* The password-reset path recreates F1: a first
  passkey added after a reset signs in only and brings no codes, and once its authority is restored by the wait, the
  account's only usable passkey may make codes at once (H2's own exception), so whoever held the mailbox and then the new
  passkey holds the tie-breaker. It is unreachable while `QED_DELIVERY=none`, because no reset can be sent. Before any
  email provider is enabled: make the codes at the sign-in-only passkey's authority request, unusable until that authority
  is restored, and revoked on cancellation.
- *Google-opened address.* The address a Google sign-in opens an account with is usable at once (`server/google.ts`). That
  is harmless: such an account has no password to reset, and an address cannot start a recovery without a saved code beside
  it. The F4 wait applies to every address of an account opened with an email address and a password.

Residual, F6 (OPEN, for the owner): on an installation with no email provider (production today), an account that never saved
the codes it was shown, or one opened with Google alone, cannot be recovered if its only device is lost: the recovery needs
a verified email, or a saved code and a second proof. A Google-only account can still sign in with Google and approves
nothing until a device is set up. The remedy is a provider decision (an email adapter, `PROVIDER_DEPENDENCY`) or a recovery
contact; neither was added here.

**A full-disk gap found on the way.** With ten fewer rows per sign-up, the write that failed first on a full disk became
the one that ended the browser's earlier session after the account's transaction had committed: an account was made
behind an answer that said nothing had changed. The earlier session now ends inside the account's own transaction
(`auth.ts` `endPresented`; `server/storage-faults.test.ts`).

**Review items fixed with F1** (independent review of 780dbeca): F4 above; F5 above; F7 wording that said more than is true
(at-once removal needs a saved code; a first device after a password reset signs in only; the opening address waits; the
reset mail of a Google-only account names Google); F11 a password change and a reset apply the sign-up's rules
(`auth.ts` `checkNewPassword`); F12 a Google sign-in ends the browser's earlier session inside the account's transaction;
F9 removing a linked Google account ends the sessions Google opened. Left as they are: F8 and F10 (low, accepted).

**Schema v10, part (a).** Account access is its own step, v9 to v10 (the watchlist's v8 to v9 step is another branch's and
is released first; a v8 database steps through both after one sealed copy). Two nullable columns on `users` and three
tables; nothing is filled. Existing accounts keep their handle, password, passkeys, codes, addresses and sessions, and gain
no sign-in address, identity or permission (`server/access-migration.test.ts`, on a schema-9 fixture with a watchlist row,
and one test that steps a v8 database through both).

