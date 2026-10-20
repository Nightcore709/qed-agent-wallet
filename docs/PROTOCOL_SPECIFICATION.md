# QED — Protocol Specification

Every message a QED contract accepts, with its exact encoding, who signs it, and what the contract checks.
Sources of truth are the Solidity files named in each section; the TypeScript encoders in
`agent/src/protocol/eip712.ts`, `agent/src/roles/trader.ts` and `agent/src/engine/*` are tested for parity with
them (`agent/test/parity.test.ts`, `contracts/test/fixtures/*`).

Conventions: tUSD and tEUR amounts are integers with 6 decimals, tETH with 18. "WAD" is fixed point with 1.0 = 10¹⁸.
All signatures are secp256k1 (EOA) or ERC-1271 (smart accounts) through OpenZeppelin `SignatureChecker`.

## 1. Roles and keys

| Role | Key | Can do | Cannot do |
|---|---|---|---|
| Owner | cold | sign mandates; configure vault (agent, co-signer, guardian, caps, epoch); ring-fence; withdraw *free* funds; name venues on `QEDExecution` | touch ring-fenced money; skip the co-signer when a mandate requires it |
| Agent (operator) | hot | call `QEDVault.executePayment`, or `QEDExecution.trade` / `pay` | anything else; pay outside the mandate; trade worse than the proof allows |
| Co-signer | warm, separate process | sign `Certificate`s after 12 checks (payments) or 11 checks plus an independent quote (trades) | call any contract function |
| Guardian | warm | `pause()` | `unpause()`, anything else |
| Creditor | any | `release` / `assign` its own liability; anyone can `settle` a due one | — |
| Provider (escrow) | any | sign `Quote`s; `deliver` a solution for its own job | be paid without the verifier's acceptance |
| Clearing member | any | `join` (consent to `TERMS`), `issue`, `pay`, submit `net` | change a net position; net without a maximality certificate |

## 2. `QEDVault` (EIP-712 domain `"QEDVault"`, version `"1"`, chain id, vault address)

```
Mandate(address vault,address agent,address[] payees,uint256 maxPerPayment,uint256 maxPerPeriod,
        uint64 period,uint256 maxTotal,uint64 validFrom,uint64 validUntil,uint64 epoch,bool requireCosign,
        bytes32 purpose,bytes32 salt)                          — signed by the OWNER
Certificate(bytes32 mandateHash,address recipient,uint256 amount,uint64 dueAt,bytes32 intentId,
            bytes32 evidenceHash,bytes32 ref,uint64 notBefore,uint64 expiresAt,uint64 epoch)
                                                               — signed by the CO-SIGNER
```

`payees` is hashed as `keccak256(abi.encodePacked(payees))`. `executePayment(m, ownerSig, c, cosignerSig)`, callable
only by `agent`, checks in this order: not paused; caller is the agent; mandate (vault, agent, period > 0,
1 ≤ |payees| ≤ 32, validity window, epoch, not revoked, owner signature); certificate (mandate hash; co-signer
signature over **every** field if `requireCosign`; epoch; validity window; intent unused; amount > 0; forward
due date within 365 days; recipient in `payees`; amount ≤ `maxPerPayment`); solvency (`amount ≤ freeBalance()`);
limits (period, lifetime, global 24 h window). Effects: marks the intent used; pays now (`dueAt = 0`) or creates a
ring-fenced liability. Event `PaymentExecuted(intentId, mandateHash, recipient, amount, liabilityId, evidenceHash, ref)`.
`evidenceHash` is keccak256 of the co-signer's canonical decision record (§7).

## 3. `QEDExecution` (no domain of its own; authority flows through the vault's certificate)

```
Order(address tokenOut,address recipient,uint256 minOut,uint32 tolerancePpm,bytes32 venueSetHash)
orderHash = keccak256(abi.encode(ORDER_TYPEHASH, tokenOut, recipient, minOut, tolerancePpm, venueSetHash))
Hop   { uint8 venue; bool zeroForOne; uint256 amountIn }      — amountIn = 0: all of the token received so far
Price { address token; uint256 value }                         — ν × 10³⁶, output-token units per input unit
Venue { address pool; address token0; address token1; uint16 feeBps }
venueSetHash = keccak256(abi.encode(Venue[]))                  — set by the vault owner with setVenues
```

A trade is authorised by an ordinary vault certificate with `recipient = QEDExecution`, `amount = A`, `dueAt = 0`
and `ref = orderHash`. The co-signer sets `minOut` from its own optimal quote less 1% and `tolerancePpm = 1`.
`trade(m, ownerSig, c, cosignerSig, order, route, prices)`, callable only by `operator`:

1. `c.recipient == this`, `c.dueAt == 0`, `c.ref == hashOrder(order)`, `order.tokenOut ∉ {asset, 0}`,
   `order.recipient ∈ m.payees` and `≠ this`, `order.venueSetHash == venueSetHash`, `tolerancePpm ≤ 10,000`,
   1 ≤ |route| ≤ 32.
2. `bound = B̂(ν)` over **all** venues from live reserves (ALGORITHMS §12.4); `ν(tokenOut)` must equal 10³⁶.
3. Snapshot balances; `vault.executePayment(m, ownerSig, c, cosignerSig)` — all vault checks apply; exactly `A`
   must arrive.
4. Execute the hops (Uniswap V2 `getAmountOut` with the venue's fee, then `swap(…, this, "")`).
5. No intermediate token may change balance; unspent input returns to the vault.
6. `out ≥ minOut` else `InsufficientOutput(out, minOut)`; `out·10⁶ ≥ bound·(10⁶ − τ)` else
   `NotBestExecution(out, bound)`; transfer `out` to the recipient.

Event `BestExecution(intentId, tokenOut, recipient, amountIn, spent, amountOut, bound, hops)`.
`pay(m, ownerSig, c, cosignerSig)` forwards ordinary payments (and refuses certificates addressed to the module).
`quoteBound(amountIn, tokenOut, prices)` is the bound as a view, used for pre-flight and by `ExecutionBounty`.

## 4. `ProofEscrow` (EIP-712 domain `"ProofEscrow"`, version `"1"`)

```
Quote(address provider,address payee,address client,address token,uint256 price,address verifier,
      bytes32 specHash,uint64 deliverBy,uint64 validUntil,bytes32 quoteId)   — signed by the PROVIDER
```

`open(q, sig)`: provider signature, `validUntil`, client restriction, `(provider, quoteId)` unused; pulls `price`.
`deliver(jobId, spec, solution)`: only the provider, before `deliverBy`, `keccak256(spec) == specHash`;
`verifier.verify(spec, solution)` must not revert; pays `payee`; records `keccak256(solution)` and the verifier's
result digest. `refund(jobId)`: anyone after `deliverBy` (or the provider at any time) returns `price` to the client.

| Verifier | `spec` | `solution` | Result digest |
|---|---|---|---|
| `MinVarianceVerifier` | `abi.encode(uint256 n, int256[] cov, uint256 tol, bytes32 universe)` (WAD) | `abi.encode(int256[] w, int256 ν, int256[] μ, int256[] L)` | hash of the certified solution |
| `PrivateMinVarianceVerifier` | `abi.encode(uint256 dataCommitment, bytes32 universe, address provider, bytes vendorSig)` | `abi.encode(uint256[2] a, uint256[2][2] b, uint256[2] c, uint256 weightsCommitment, uint256 variance)` | `keccak256(abi.encode(weightsCommitment, variance))` |

Vendor attestation (private verifier): EIP-191 signature by `dataVendor` over
`keccak256(abi.encode(keccak256("QED Private: data attestation v1"), chainid, dataCommitment, universe))`.
Groth16 public signals: `[weightsCommitment, variance, dataCommitment, provider]`, each a canonical BN254 element.

## 5. `QEDClearing` (consent by transaction, no signatures)

Members call `join()`, emitting `Joined(member, index, TERMS)` with
`TERMS = keccak256("QED Clearing v1: I consent to any netting that leaves my net position unchanged, creates no new claim, and is proven maximal on-chain.")`.
`issue(creditor, amount, dueAt, memo)` creates an obligation (members only, no self-obligation, at most 128 open); `pay(id)` lets the debtor settle it with tokens.

```
Netting { uint256[] ids; uint128[] amounts; uint128[] x; int256[] potential; uint128[] y }
```

`net(p)`, callable by anyone, requires: `ids` = every open obligation, strictly increasing, with `amounts` equal to
current amounts; `0 ≤ x ≤ amount`; every member's net position unchanged; `π_debtor − π_creditor + y ≥ 1` for every
obligation; `Σx = Σ amount·y` (maximality); `Σx > 0`; potentials and multipliers bounded by 2⁶⁴. Event
`Netted(round, prover, obligations, grossBefore, cleared, grossAfter)`.

## 6. Bounties

| Contract | `claim` input | Pays iff | Otherwise |
|---|---|---|---|
| `OptimalityBounty` | `(spec, solution, int256[] x)` | the deployed `MinVarianceVerifier` accepts `(spec, solution)`, x is feasible, and F(w) − F(x) exceeds the §4.4 bound | `TheoremHolds(advantage, bound)` |
| `MaximalityBounty` | `(Economy, Certified, uint256[] alt)` | `QEDClearing`'s acceptance rule accepts `Certified` and `alt` is a valid larger netting | `TheoremHolds(cleared, alt)` |
| `ExecutionBounty` | `(amountIn, tokenOut, Price[] prices, Hop[] route)` | the route, run on the bounty's own funds through the module's venues, beats `QEDExecution.quoteBound` | `TheoremHolds(out, bound)` |

## 7. Off-chain records

Decision records are canonical JSON (`agent/src/protocol/records.ts`: sorted keys, bigints as decimal strings),
hashed with keccak256. The co-signer's record (`schema: qed.decision-record/v1`) contains the request, every check
with its verdict and detail, the treasury snapshot and, for trades, its own quote, route and prices; its hash is the
certificate's `evidenceHash`, anchored on-chain by `PaymentExecuted`. Owner instructions confirmed by signature use
EIP-191 over the exact strings in `agent/src/roles/cosigner.ts` (`ownerInstructionMessage`, `ownerTradeMessage`).

## 8. Replay and domain separation, summarised

| Message | Bound to | Replay protection |
|---|---|---|
| Mandate | chain id, vault (domain); agent | epoch, revocation, validity window |
| Certificate | chain id, vault (domain); mandate hash; every payment field | `intentId` single use; validity window; epoch |
| Order | the certificate (`ref`) | the certificate's `intentId` |
| Quote | chain id, escrow (domain) | `(provider, quoteId)` single use; `validUntil` |
| Private proof | provider address (public signal), data commitment, vendor attestation with chain id | job single settlement |
| Netting | the exact set and amounts of open obligations | amounts change after netting, so a replay fails `IncompleteSnapshot` |
