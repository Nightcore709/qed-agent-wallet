# QEDDisputeEscrow: a review and dispute step in front of the release's ProofEscrow

R13, audit item E3. A local research contract, deployed only on the wallet's local Anvil chain (`rail/disputes.ts`). Not audited.

## Why a contract, not QED's own off-chain terms

The release's `ProofEscrow` pays its payee in the same transaction in which its verifier accepts a certificate (`vendor/contracts/src/ProofEscrow.sol:13-21`). Once a client has funded a job there, nothing QED does off chain can hold that payment back for a review. So QED's own terms enforced before release cannot give either side a real dispute:

- when the household is the client, the provider is paid before QED could ask anything;
- when the household is the provider, the household would judge its own case.

The sound route is a contract that the money passes through between verification and payout. It is this one. The release's `ProofEscrow` stays unmodified. This contract is its client and its payee, so the payment for verified work and the refund for missing work both come here first.

## Terms, roles and deadlines

The terms are fixed before any money moves (`QEDDisputeEscrow.Terms`):

- the client, the provider's payee, and a named decider;
- the decider's powers: pay the provider in full, refund the client in full, split;
- three periods: the review, from delivery; the evidence period, from a dispute; the decision deadline, also from the dispute;
- two timeout outcomes, each as the provider's share in basis points.

The provider signs them through the release's own quote: it names this contract as client and payee, with `quoteId = termsHash(terms)`. One signature therefore binds the price, the work, the deadline and the terms. The client accepts them by opening the job; only `terms.client` can.

| State | Who may act, and when | What happens |
|---|---|---|
| Funded | The provider delivers to `ProofEscrow`. The provider releases the client before the deadline. Anyone reclaims after the deadline. | On verification, the price comes here. On a release or a reclaim, it comes here and goes on to the client. |
| Delivered | Anyone records the delivery (`noteDelivered`); QED does it in the delivery's own transaction. The client accepts, or disputes until the review ends. The provider gives way. After the review ends, anyone may finish. | Accepting pays the provider in full. Giving way refunds the client in full. Finishing applies the review timeout's share. |
| Disputed | Both sides add evidence (hashes) until the evidence period ends. The decider rules after it and by the deadline, within its powers. Either side may still give way. After the deadline, anyone may finish. | A ruling pays both parts. Finishing applies the decision timeout's share. |
| Closed | Nobody. | Paid once. The two parts always add up to the price, the client's part rounded down. |

There is no owner, admin, pause or upgrade. Every state ends: after the delivery deadline, the review and the decision period, anyone can close any job (`testFuzz_EveryJobCanBeClosedInTime`).

## What the chain enforces, and what QED does

| The chain enforces (this contract, tested) | QED does (server and rail, tested) |
|---|---|
| Only the named client opens, accepts or disputes. Only the provider gives way. Only the decider rules. | Before the provider signs, it checks that the decider is a third household with an on-chain wallet that shares no member with either side. The chain only checks that the three addresses differ. |
| A dispute only during the review. Evidence only during the evidence period. A ruling only after it and by the deadline, and only with an allowed outcome. A timeout only once its period has passed. No gap or overlap between windows. | It offers the periods and outcomes of the paper escrow's policy (`server/escrow.ts` POLICY): the defaults, the bounds and the reasons. Periods are in days; seconds only on an isolated test stack, labelled so. |
| Money goes only to the provider's payee and the client, in parts that add up to the price. The decider receives nothing. One job's payout never reaches another job's money. | It keeps the texts of the reason and the evidence; their keccak256 is what the chain records. It shows every term before each side signs, and asks for the passkeys of the side whose step it is. |
| The terms cannot change after the provider signs: altered terms do not match `quoteId`, and a recomputed `quoteId` breaks the provider's signature. | It reads every state back from the chain. It names the outcome of a closed job, and books the movements as escrow movements (`rail/movements.ts`). |
| Tokens that take a fee on transfer are refused at opening. | It quotes only its own test token. |

## Threat model and accepted limits

| Threat | Result |
|---|---|
| A client who disputes everything, to delay payment | It delays payment by at most the decision period. The decision timeout's share then applies; it is a stated term, 50% by default. There is no dispute bond. |
| A decider who colludes with one side | It can rule only within its stated powers and only for that job. QED checks that the decider shares no member with either side. It cannot tell when one person runs two accounts (the same limit as R7 D7, assumption A-ID). |
| A delivery nobody records | Anyone may record it. Its review then starts later, which can only give the client more time. QED records it in the delivery's own transaction. |
| A token that blocks transfers, or calls the recipient back | The payout reverts and the job waits. Such tokens are not supported, and QED uses none. |
| Front-running at a deadline | No gap and no overlap between windows: at the last second only the earlier step is open (`testFuzz_TheReviewHasNoGapAndNoOverlap`, `testFuzz_TheDisputeWindowsDoNotOverlap`). |
| Re-entrancy through a token or the proof escrow | Every external function is `nonReentrant`; state is written before each external call. Opening checks the proof escrow's new job number and that its own balance is unchanged afterwards. |

## Tests and evidence (all local; no network, no RPC, no Anvil for Forge)

By hand, always naming the compiler: `SOLC_VERSION=0.8.26 forge test`. Everything, recorded in `evidence/`: `scripts/run.sh`.

- **Unit and fuzz:** `test/QEDDisputeEscrow.t.sol` (32) and `test/RealVerifier.t.sol` (1). The latter uses the release's own `MinVarianceVerifier` and fixture: a counterfeit certificate moves nothing; a certified one settles here, not to the provider.
- **Invariants** (`test/invariant/`, 7, run against a handler that drives random lifecycles):
  - money is conserved;
  - the amount held is exact and covered;
  - every closed job adds up to its price;
  - money goes only to the parties;
  - each step is taken only by its side;
  - the deadlines hold;
  - a closed job is final.
- **Seeded twins** (`seeded/`, expected to fail; `scripts/make-seeded.py` writes the copy from the source, and `--check` keeps it in step):
  - the decider may rule during the evidence period: the deadlines invariant fails;
  - a timeout split rounds both parts down: the add-up and conservation invariants fail;
  - anyone may accept: the side invariant fails.
- **Sanity and reachability:**
  - the faithful copy passes all seven invariants;
  - the reachability canaries on the real contract fail, as designed, for every outcome (accepted, review timeout, ruling, split ruling, decision timeout, provider gave way, reclaimed).
- **Artifact:** `artifacts/QEDDisputeEscrow.json` is checked against the build. Forge's build of `ProofEscrow` is byte-identical to the release's embedded bytecode.

## Slither (0.11.6, on a copy of the source; `evidence/slither.txt`)

Nine results touch `QEDDisputeEscrow.sol`. The rest are in the vendored release and OpenZeppelin files.

| Detector | Where | Disposition |
|---|---|---|
| reentrancy-balance (High/Medium) | `open` | **False positive, by design.** `before` is the balance before the client's payment. Comparing it after `ProofEscrow.open` is the intended postcondition: the client paid exactly the price in, and the proof escrow took exactly the price out. Re-entry into this contract is blocked by `nonReentrant`. A balance changed during the call makes `open` revert, so it fails closed. |
| timestamp (Low/Medium), seven results | `noteDelivered`, `dispute`, `addEvidence`, `decide`, `finish`, `reclaim`, `_close` | **Accepted, by design.** The terms are deadlines, and block time is how a contract keeps them. A validator moves the timestamp by seconds; the periods are at least a minute, and days in QED. Windows have neither gap nor overlap (fuzz tests above). |
| pragma (Informational) | the vendored `ProofEscrow.sol:2` | The release's file, not changed here. |
