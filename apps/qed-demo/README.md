# QED: local review build

An autonomous financial wallet that acts only within authority its owner has signed with a passkey: it spends,
saves, grows, earns and protects. An engine runs on this computer: it reads live public market prices, runs signed
instructions on their schedules, checks every action against the signed limits and the household's own safety
rules, sends it to a paper venue or to the owner's wallet on a local chain, compares the result with the venue's
books and issues a receipt. The interface shows what is yours, what QED may do, and what happened and why.
**Prices are live. The money is practice money: paper balances and valueless test tokens on a chain on this
computer. Nothing here can reach a real bank, broker, exchange account or public chain.**

This file says how to start it, what to try, what is live and what is not, and where the evidence is. Rewritten on
22 November 2026 for the passkey accounts and the on-chain wallet service, on 23 November for ordinary sign-up with a
password, and on 24 November for the "Meridian" interface (`DESIGN.md`, section "Meridian") and encrypted copies.

## Start it with one command

```bash
cd "$(git rev-parse --show-toplevel)/apps/qed-demo"
scripts/review-build.sh restart     # or: start, stop, status
```

Then open **http://localhost:5174** (the name `localhost`: a passkey is bound to it; http://localhost:5175 serves
the same interface as a production build). `restart` stops a running review build gracefully, seals a backup of the
stopped wallet service's data under the backup key, builds the interface, and starts the wallet service (with its
local chain on 8546), the engine and the API together, then the live-reload interface. A database made by an earlier
build is migrated once on that start, after a sealed copy of it is taken: the keys live in `~/.qed/keys` (made once
with `npm run keys:init`; `docs/ENCRYPTION.md` section 8). Logs are in `data/review-*.log`. The steps it runs are
below, for doing them by hand.

## Start it by hand

Needs Node 26 (26.12.0 or later, below 27: `package.json` engines and `.nvmrc`; the server uses Node's built-in
TypeScript support and SQLite) and, for the on-chain wallet, Foundry's `anvil` (v1.7.1) in `~/.foundry/bin`. Deploying it
on GitHub and Railway, with the container image, the supervisor and the rehearsed restart, backup, restore and rollback:
`docs/DEPLOY.md`.

```bash
cd "$(git rev-parse --show-toplevel)/apps/qed-demo"
npm ci --ignore-scripts
npm run build
```

Then, each in its own terminal:

```bash
npm run engine
```

```bash
QED_WEB_PORT=5174 npm run api
```

```bash
cd chain && PATH="$HOME/.foundry/bin:$PATH" QED_RAIL_SEAL=1 node serve.ts
```

`QED_RAIL_SEAL=1` keeps the wallet service's master secret and co-signer keys sealed under the key-encryption key
(`npm run keys:init` first; `docs/ENCRYPTION.md` section 9). Once sealed they are always read sealed, so later starts
need the keys whether or not the variable is set.

Open **http://localhost:5175** (the name `localhost`, not `127.0.0.1`: a passkey is bound to the name of the site
it was made for). A database made by an earlier build is moved to the current schema on the API's first start (v4,
23 Nov: a recovery is finished with a reference only its starter is given), and a copy of it as it was is kept beside
it as `qed.db.pre-v4-<time>.bak` (sealed instead, when encrypted backups are configured); a recovery still open from before cannot be finished and is started again. The API serves the interface and answers only on this computer. The third terminal runs the
on-chain wallet service (127.0.0.1:5176, with its own local chain on 8546); without it everything except the
on-chain wallet works, and the wallet's pages say it is not reachable.

- **Create an account** on the first screen, in one of two ways. With a passkey: your device makes one (fingerprint,
  face or device PIN). With a password: a handle and a password of ten characters or more. Either way QED shows ten
  recovery codes once (copy or download them). A password account is then offered the passkey that approves
  payments; "Not now" is allowed, and until a passkey is added the account can look at everything and set up but
  approve nothing (every approval is a passkey signature over the exact terms; D-094). Then open a paper household
  with the example figures or your own, beside a live preview of where they leave you. Home lists what is left to
  finish (the passkey, the on-chain wallet, a first instruction) until it is done.
- **Sign in** with a passkey (one press) or with the handle and password. "Recover your account" starts a recovery
  with a saved code and either a recovery contact's code or, for a password account, the password. It waits 72 hours,
  any of the account's passkeys can cancel it, and it is finished only with the reference shown when it starts ("Finish
  it with its reference" on the same screen, on any later visit): someone signed in to the account sees the recovery
  but cannot finish it. A session opened with a password approves nothing and cannot weaken a protection
  (`SECURITY.md` section 8, D-094).
- **The engine is the product.** Closing the browser, or signing out, does not stop it. Ctrl-C in its terminal
  does; so does this computer going to sleep. What fell due while it was not running is recorded as missed and is
  never executed late.
- `npm run dev` serves the interface with live reload on http://localhost:5174 (the engine and API running).

Other commands: `npm run status` (engine, data sources, latest prices), `npm run verify` (re-derives every
balance from the ledger and re-checks every receipt's fingerprint), `npm run reset` (moves the database aside; it
never deletes), `npm test`, `npm run typecheck`. Settings, all optional: `QED_DB`, `QED_API_PORT` (5175),
`QED_WEB_PORT` (5174), `QED_AI_PROVIDER` (`auto`, `anthropic`, `claude-cli`, `none`), `QED_AI_MODEL` (the command-line client's model), on the API `QED_AI_MODELS` with its spending limits (`QED_AI_BUDGET_USD` and the rest, `docs/DEPLOY.md` section 24),
`QED_RAIL_URL` (loopback only), `QED_PRESENTATION=1` (presentation mode: every price synthetic, on a database of
its own), `QED_ASK_DAILY` and `QED_ASK_MONTHLY` (questions to the model per workspace; 100 and 1,000). A production
setting, off here: `QED_ADVISER_REVIEW=1` with `QED_ADVISER_TOKEN` (32 characters or more) holds each investment
proposal a model drafts (invest, rebalance, sweep, exit, floor, split) until a SEBI-registered investment adviser
approves it through `GET /api/adviser/queue` and `POST /api/adviser/reviews/:id` (header `x-qed-adviser`); the signed
document then names the adviser and the registration they gave, for the reviewed terms only (N-006,
`server/adviser.ts`).

## What to try

Each takes a minute or two. The sections are the five pillars, with Home and Activity around them.

1. **Home.** What is free to use, in the peacock field, with the runway: how low the bank balance would stand on
   each coming day if the worst you allow for happens (true steps, the free band, the lowest point, bills and salary
   marked; point at it or focus it and use the arrow keys to read any day). Beside it what needs you, with what
   happens if you do nothing, and what is coming up; below, what QED may do (one card per signed grant with what is
   left of its limit), where your money is (one bar of every place it sits, then each account and what you owe) and
   what happened, by whom, with the seal where a receipt is kept. Four actions of equal weight: pay, buy or sell,
   a new instruction, Ask.
2. **Spend.** One studio: on the left, who the money goes to (bills waiting, your payees, your own card, loans and
   deposit) and adding a payee, which names a look-alike before it is added; on the right, the payment being
   composed: who they are and whether you have paid them before, the amount against what is free, the rail, then
   the exact terms in the signing sheet and your passkey. Bills on record and every payment so far follow. "Pay this
   bill" on Home, or "Pay it now" beside a bill, lands on the payment's review with the bill chosen (on a phone too);
   a bill with a payment on its way says so and is not offered again. The signing sheet names the payee and address,
   a bill's reference, due day and fee, and the route; two minutes before it lapses it says so, and "Keep it open"
   gives ten more minutes on the same terms. Let go of "Hold to approve" too soon and it says how to finish.
   "Pay from: On-chain wallet" pays the payee your wallet's mandate names, in test rupees on the local chain, signed
   in the same sheet and followed on the page; "Open its record" shows the transaction. The payees `decline@paper`,
   `slow@paper`, `timeout@paper` and `reverse@paper` exercise a declined, a slow, an unanswered and a returned
   payment. Adding a payee runs the paper bank's name check first (a small directory on this computer, not a bank):
   `ravi.kumar@upi` holds "Ravi Kumar" (type "Ravi Kumaar" for a close match), `nocheck@paper` is a check that does not
   answer, and an address it does not know cannot be checked. In a payee's first 24 hours, a payment that takes what
   you send it above the amount set in Safeguards (₹10,000 at first) waits 24 hours, with its money set aside, and can
   be cancelled on its record until then.
3. **Write an instruction** (New instruction, or Protect). Change the amount, the schedule or a limit and watch the
   document change, including the most it can ever move ("Not over ₹… before …"). If the schedule asks for more
   than its limit, signing is held until you accept the contradiction point by point. Sign it with your passkey.
4. **Save.** What must stay in the bank, why, the hardest day ahead, and the most your instructions could take.
   "Set aside on the chain" puts test rupees aside for a creditor on the wallet's contract: only they can receive it.
5. **Grow.** Live prices with their age and source; a chart of recorded prices that says what it answers ("How has
   the price moved over 24 hours?"), answers it in words with exact values, reads any point under the pointer or a
   finger, gives the same values as a table and shows gaps as gaps; buy or sell against the live order book (paper
   fills, real prices). "Dollar reserve on the chain": convert test rupees by hand after reading the limits and a
   price, or sign a standing policy that keeps the reserve topped up on its own.
6. **Earn.** A job with milestones; the client accepts or disputes; money arrives. "Work paid through escrow on the
   chain": between two households, the client funds a milestone from its wallet, the provider delivers a certificate
   the chain verifies, the escrow pays the provider's wallet, and the authority it earned is credited after
   confirmations.
7. **Protect.** Everything QED may do, each with its own pause; your account's passkeys, recovery contacts and
   sessions; who can sign for the on-chain wallet (add a passkey as a signer, schedule a removal, set up a recovery
   key whose code never leaves the device); the floor and the records; the on-chain wallet's mandate; what this build
   is.
8. **On-chain wallet** (its own section; needs the wallet service). Four steps, shown as a path: create it (an owner
   account on the local chain whose signer is your passkey), own it (accept it with one signature), fund it (the
   opening grant arrives on acceptance) and delegate (sign a mandate). Then the overview: the treasury and the
   dollar reserve with every limit that applies and the contract's worst case if its keys were stolen; the mandate
   as a signed document; signing a new one, pausing, revoking and replacing keys. Pay the one approved payee, set
   money aside for a promise, convert rupees into the dollar reserve, sign a standing conversion policy that the
   engine then runs by itself. Each job's page shows every step as it ran and the transaction (hash, block, result)
   as its proof. Every owner action is signed by your passkey over the exact digest the chain checks. The Treasury
   page's Receive panel gives your own account's address with the chain before it (`eip155:31337:0x…`), copies it,
   and checks an address someone gives you against it.
9. **Activity.** Orders and payments, the bank statement, and the on-chain records. Open any line for its record:
   asked, authorised, each check with its figures, sent, executed, compared with the venue, receipt.
10. **Pause QED**: the control at the foot of the sidebar (at the top on a phone), with QED's state and its
    instructions in force. Its sheet says what stops, what can keep running
    (protective selling, if you choose) and what cannot be recalled, then what will not happen in the next two weeks
    and what happens anyway (your bank's instalments, bills no instruction pays). In an emergency it can also sign out
    every other session and pause the on-chain wallet's contract (your passkey signs that). While paused, Home says QED
    may move ₹0 and no instruction announces a next run; the wallet's standing policy does not tick, on its own or when
    "Tick once now" is pressed; what you sign yourself still works. Resuming needs your passkey. Without your device:
    "Recover your account" on the sign-in page has "Pause QED first, with a saved code" (all but protective selling;
    no session, no money moved), and a recovery contact can pause it for you from their own account.
11. **Ask QED** (in the sidebar, or Cmd-K). Each reply says who wrote it, whether every rupee figure in it was found
    in your records (a figure that was not is named), which records it rests on and where to act. A proposal shows
    its limit, how far QED's own code could check it, its figures, and where it stands (proposed, draft opened,
    signed). A proposal is only a draft: it becomes an instruction when you sign it, after the same checks as one
    you wrote. A proposal for the on-chain wallet (a policy, a payment, money
    set aside) is checked against the mandate and signed in the wallet's sheet; who proposed it is part of what you
    sign. Without a model connected, Ask offers what fixed rules find.

## What is live, what is paper, what is not there

| | State |
|---|---|
| Market prices | **Live**, public, no account: CoinDCX (rupee prices and order books), Binance and Coinbase (independent prices), AMFI (fund NAVs), ECB through Frankfurter and the New York Fed (reference rates). Each price carries its source, source time, time received and age; a stale price cannot be used to execute. Kraken is excluded |
| Orders | **Paper.** Filled against the live order book or the published NAV by a paper venue with its own books. No order reaches an exchange or a fund house |
| Payments | **Paper.** A paper rail with UPI, IMPS and NEFT timings and limits as modelled rules |
| Bank, card, loans, salary, instalments, interest | **Paper**, at rates and rules on the terms register, each marked checked, not yet checked, or modelled |
| The engine: schedules, authority checks, execution, reconciliation, receipts, recovery | **Real software, running.** It is what would run against real venues |
| The vault's contracts | **The release's own, unmodified**, on a local chain with valueless test tokens. Each household's vault is owned by an account on that chain whose signers are its passkeys; the vault service holds no key that can act as the owner (since 22 Nov 2026; before that, one vault with the release's development owner key) |
| Ask | A real model when one is configured (the signed-in Claude command-line client, or an API key); otherwise fixed rules only. It can only propose. It holds no credential and cannot approve, send or change anything |
| Real money, real accounts, a public chain, a hosted service | **Not there, on purpose.** Each needs the owner's separate approval |
| Identity checks, tax reports, a native mobile app, notifications outside the page | **Not built** (the interface works at phone width) |
| Markets beyond a few digital assets and Indian mutual funds; business and institutional accounts | **Not built.** The engine's contract (an instrument, a venue, a signed authority, checks, a receipt) does not assume a household; nothing demonstrates it beyond one |

## Evidence

Each file was produced by the command beside it, on this computer, by the orchestrating agent. None has been
reproduced by anyone else yet. The recovery, security, vault, accessibility and interface-closed files were
produced again on 20 November between 15:39 and 16:01 IST, after the last corrections: the first three on the
code of commit `94ef5b6`; the interface-closed run on `99a0f90`; the accessibility run on `7e05dfd`, against the
built interface at http://127.0.0.1:5175. Between those commits the server changed in one place (how two prices are
written in one sentence of one check, `9bc788a`) and the interface in one (focused controls kept clear of the
pinned bars, `7e05dfd`). After them, one commit evens the spacing of two headings in the form for writing an
instruction; nothing was run again for it.

| File in `evidence/` | What it shows | Command |
|---|---|---|
| `20261120-overnight-sleep.json` | A real night: the computer slept 26 times; 8 runs fell in those gaps, were recorded as missed and not executed late; no run was executed twice | `node scripts/evidence.ts` |
| `20261120-recovery.json` | 15 of 15: the engine killed with a payment in flight; an order approved while it was down; revocation while a run waited; the API killed; an order too late to send | `node scripts/recovery.ts` |
| `20261120-security-active.json` | 54 of 54 active checks on an isolated copy: another owner's data, forged and replayed approvals, cross-site requests, limits, rate limits, the built interface's routes, and six ways of weakening a protection or moving money without the password (a lower floor, a weaker reserve, a lower spending figure, a removed bill, undoing a stop, ₹10,000 split into pieces) | `node scripts/security.ts` |
| `20261120-accessibility.json` | On the built interface at 127.0.0.1:5175, 24 screens, the vault's inner screens included. 96 axe runs (WCAG 2.2 A and AA) in light and dark at two widths: no rule violated. One top heading and ordered headings everywhere. No sideways overflow at seven widths, two of them a desktop window zoomed to 200% and 400%. Every screen walked with Tab and Shift+Tab at three sizes: of 5,176 focus stops none is hidden under the bar pinned at the top or the phone's bar at the bottom (before 20 November's correction 123 were, on seven screens). Skip link first; a visible outline on each of 38 stops. The approval sheet opened, tabbed through and closed with the keyboard alone, focus returned. No animation when less motion is asked for. No screen failed to draw; no console error. An automated pass finds a minority of faults | `QED_UI=http://127.0.0.1:5175 npm run a11y` |
| `20261120-model-proposal-path.json` | A proposal from a real model, validated, signed, run, reconciled and receipted, with the time of each step | `node scripts/evidence-proposal.ts <instruction id>` |
| `20261122-vault-journey.json` | 27 of 27 through the wallet's API on its own stack, with each household's vault owned by its passkeys and the authority budget of R7 decision D7 as the co-signer's check: the vault set up with this passkey as its one signer and accepted with the passkey's signature over the owner account's digest; a mandate signed through the account (ERC-1271); a payment to the approved payee, a promise for a later day, money set aside, the owner's money out and back; a smaller venue set that waits out the account's delay and is cancelled with one passkey; what a payment may be, read without preparing anything; a conversion, its repeat and one above the limit; an attack that reverts on a throwaway chain; a standing policy, which the engine then ticks by itself (a 250 tINR tranche) with nothing asking it to, and a tick by request; pause and resume; after the conversions, which took only their real cost, a payment within what is left goes through and one beyond it is refused naming the budget; a 20 tINR grant signed by the passkey (granted, not earned), after which the same payment goes through; the decision records re-hashed; a second household with its own vault that cannot reach the first | `node scripts/vault-journey.ts --isolated` |
| `20261120-vault-journey.json` | Superseded by the 22 November run: made on the single-owner vault with the development owner key. 23 of 23 through the wallet's API on its own stack: the vault wired; a mandate signed; a payment to the approved payee, a promise for a later day, money set aside, the owner's money out and back, a smaller venue set and the full one again; what a payment may be, read without preparing anything; a conversion, its repeat and one above the limit; an attack that reverts; a standing policy, which the engine then ticks by itself within one five-minute slot with nothing asking it to, and a tick by request; pause and resume; a payment refused once the co-signer's allowance is used; the decision records re-hashed; a second owner kept out | `node scripts/vault-journey.ts --isolated` |
| `20261120-away.json`, `20261120-away/*.png` | 10 of 10. On an isolated copy: an instruction signed through the interface in Chrome at 15:47:07; Chrome closed at 15:48:03; 360 samples over 12 minutes, each showing no interface connected and the engine running; five runs fell due in the part of that time the check counts (it leaves out the last 20 seconds) and each started within a second of its time, was reconciled and receipted; a sixth, due four seconds before the return, was done as well; Chrome reopened at 16:00:04 and the passbook listed all seven purchases | `npm run build && npm run away -- 12 evidence/<name>.json` |
| `20261120-unattended.json` | **Superseded by the row above.** A 53-minute watch on the review copy; an interface was opened from elsewhere part-way through, so it shows less than intended | — |

## Tests

```bash
npm test
npm run build && npx playwright test -c browser/playwright.config.ts
```

The first runs the unit, property and integration tests (about 10 seconds): the ledger, the engine, authority and
approvals, passkeys and recovery, the paper venues, instructions of every kind, the model boundary, the reserve,
the vault bridge, and the checks that keep `CAPABILITIES.md` and `REGISTER.md` true to the files they name. The
second is the browser suite (`browser/`, about two minutes): 37 journeys at this writing, driven through the built
interface on isolated stacks with fresh passkey accounts (a virtual authenticator), each compared with the stack's
own database, engine and chain: sign-up, recovery and ending sessions, payments and their unanswered or declined
outcomes, a look-alike payee named before it is added or paid, the statement download, the account menu by keyboard, instructions and their contradictions (by hand and through Ask), pausing, the
on-chain wallet from Spend, Save, Grow, Earn and Protect, its signers and recovery key, earning through the escrow,
two households and a business workspace side by side, a restart of every service, keyboard-only journeys,
reconciliation, presentation mode, the chart, the evidence cases and the release's historical record. The model is
the suite's scripted test double, labelled as such; no real model is called. The security suite
(`node scripts/security.ts <report.json>`, 102 checks) and the adversarial Ask corpus
(`node scripts/adversarial-ask.ts`) run against their own isolated stacks. The chain part has its own suite (`cd chain && npm test`,
about four minutes, needs `anvil`). Current counts for each revision are in the newest entry of
`docs/shared/HANDOFF.md`; a count is evidence only for the revision it was run on.

The design is checked on the rendered screens too: `node scripts/design-fixture.ts` starts an isolated stack with
one realistic household; `node scripts/design-shots.ts <label>` photographs every screen at desktop and phone width
in light and dark; `node scripts/design-checks.ts` fails when a screen falls back into a fault the owner named when
rejecting earlier designs (identifiers or chain jargon on a primary screen, more than one pause control, sideways
overflow, a column left nearly empty beside a tall one).

The mathematics behind the reserve has a reference implementation with exhaustive-search tests in
`experiments/r6/E1-flow-envelopes` and a clean-room second implementation and proof review in
`experiments/r6/E1-independent` (the reviewer was an agent of the same model family, not an independent party).

## Where things are

| Path | What |
|---|---|
| `server/` | The engine and the API. `ledger.ts` (double entry, append-only), `execute.ts` and `policy.ts` (one action from asked to receipted; every check), `programs.ts` and `runner.ts` (instructions and their runs), `liquidity.ts` (what must stay in the bank), `valuation.ts` (worst case and floor), `market.ts` (live data), `venues.ts` (paper exchange, fund registrar, payment rail), `recon.ts`, `receipts.ts`, `ai.ts`, `rail.ts` (bridge to the vault) |
| `shared/` | Arithmetic used by server and interface alike: fixed-point money, the no-regret checkers, flow envelopes, hashing |
| `src/` | The interface: `screens/`, `ui/` (kit, charts, the signing sheet), `styles/` (`app.css` imports tokens, base, components, shell and one file per screen), `fonts/` (Anek Latin, OFL). How it is meant to look, read and behave: `DESIGN.md` (section "Proof") |
| `chain/` | The vault: the release's contracts and engines on a local chain. `chain/README.md`, `chain/PARITY.md` |
| `CAPABILITIES.md` | The one mapping of the release's 86 capabilities to this build: where each is reached, what ran, and its status. Checked by `npm run capabilities` and by the tests |
| `scripts/` | Evidence and maintenance scripts |
| `browser/` | The browser suite: journeys on an isolated stack with fresh passkey accounts |
| `REGISTER.md` | The one requirements and evidence register, with three views of readiness. Generated by `node scripts/register.ts --write` |
| `data/` | The database, logs and local fixture state. Not committed |

## Known weaknesses

The full, current list is the register (`REGISTER.md`: three views of readiness, complete product, competition and
production, none of them ready) and `SECURITY.md` section 8. The ones a reviewer meets first:

- It runs on one computer. If the computer sleeps, the engine sleeps; that is recorded honestly but it is not the
  same as a service that is always on.
- No real model has been run since 20 Nov: every proposal in the tests and the evidence was written by a scripted
  test double, labelled as such on every screen (a live run needs the owner's approval, Q-051). The adversarial Ask
  corpus shows what QED's own checks refuse whatever a model proposes.
- A fresh passkey sign-in counts as a re-authentication for five minutes, during which a passkey can be added or the
  recovery codes replaced without another prompt; an approval no longer does (claims review F1). Adding a passkey
  takes effect at once, without the delay that removing one waits.
- On the on-chain wallet, a stolen household passkey is a full signer until its removal applies, and a recovery is
  checked only against the recovery code; notices are in the app only (RISK-053).
- Some limits on how far a holding can fall are calibrated against price history and some are illustrative; each
  says which. A calibrated limit is not a worst case.
- The reserve counts what is on record: a recurring bill not yet registered is not in it. It looks 150 days ahead.
- No independent party has reviewed the code or reproduced the evidence. Reviews so far were by agents of the same
  model family as the author, briefed by the author; each found real faults that the author's own tests had not.

## Boundaries

Nothing in this folder reads or changes `~/qed-approved-release`, the public QED deployment, Railway, GitHub
settings, production credentials, deployed contracts, wallets or live accounts. The local chain uses isolated test
identities and tokens without value. Market data is used for the owner's own review on this computer and is not
republished.
