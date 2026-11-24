# A signer the rail does not hold: design proposal

> **Superseded on 22 Nov 2026 (R7).** Built differently from this proposal: the owner is a passkey account
> (`QEDOwnerAccount`, `chain/accounts/`), not an EOA in a wallet or a signer process. A proposal carries `terms.toSign`
> (the account's execute digest, or its ERC-1271 replay-safe hash), the approval carries the members' WebAuthn
> assertions, and the rail checks them on chain before it relays (`rail/owner.ts` → `PasskeyAccountOwner`). The
> release's development owner remains only in the baseline-parity mode (`rail/owner.ts` → `ReleaseDevelopmentOwner`).
> The contract and HTTP details are in `README.md` › "The multi-tenant HTTP contract (R7)"; the tests are
> `test/workspaces.test.ts`, `test/workspaces-http.test.ts` and `test/owner-account-wiring.test.ts`. The text below is
> kept as it was written.

Status: **proposal only. Nothing in this note is built or tested.** Written 20 Nov 2026 for "Not finished" item 1 of
`PARITY.md` (baseline F-014, weakness W-01: "signed with a key the server does not hold").

## What is wrong today

`rail/keys.ts` → `OwnerSigner` holds the owner's key inside the rail's process. It is a development key derived from
a public string. It signs or sends only what an approval binds: it recomputes the hash of the terms and refuses on any
difference. That binds the owner's click to the bytes that are signed. It does not make the owner independent of the
service: any code running in the rail's process can call the signer, and whoever holds the rail's bearer token can
present an approval object. The approval is a statement by the backend that the owner confirmed, not a proof of it.

## Proposal: the approval carries the owner's signature, and the rail only verifies

1. **A port instead of a key.** Replace `OwnerSigner` with an `OwnerPort` interface, as was done for the co-signer
   (`CosignerPort`): `address()`, and one method per thing an owner produces. Two hosts: `DevelopmentOwner` (today's
   behaviour, labelled in `GET /state` as `roles.ownerCustody: "rail-process"`) and `ExternalOwner`, which holds no key.
2. **A proposal says exactly what must be signed.** Each proposal gains `toSign[]`. An entry is one of:
   - `eip191`: the text already in `terms.message` (conversion, payment, policy, policy revocation);
   - `eip712`: the mandate's typed data, with the domain of the vault;
   - `transaction`: one complete unsigned transaction per owner action (to, calldata, nonce, gas limit, fees, chain
     id 31337), for `setAgent`, `setVenues`, `pause`, `withdraw` and the other owner calls.
   `termsHash` covers `toSign[]`, so the document the owner sees and the bytes the wallet signs are one object.
3. **The approval carries signatures.** `approval.signatures[]`, one per entry, made by the owner's wallet. The rail
   recovers the signer of each and requires it to equal the vault's `owner()` read from the chain. Owner-signed
   transactions are broadcast as they are (`eth_sendRawTransaction`); the rail never signs for the owner. The
   contracts need no change: the vault already checks the mandate signature (EOA or ERC-1271), the co-signer already
   checks the instruction and policy signatures, and owner calls are already `msg.sender == owner`.
4. **Where the key lives.** In the owner's own wallet: a browser wallet or hardware wallet for an owner who has one.
   For the local review app, a small `owner-signer` process that the owner starts, with its own key file (mode 600)
   that neither the rail nor the backend reads, and its own window that shows the terms it is about to sign. It must
   show them itself: a signer that signs what the backend's page displays adds nothing against a compromised backend.

## What it costs

- **A changed HTTP contract**: `toSign[]` on every proposal, `signatures[]` on every approval. The five-field
  approval of today stays valid only for `DevelopmentOwner`.
- **Owner transactions carry a nonce**, fixed when the proposal is prepared. Two open owner-transaction proposals
  conflict; the second must be prepared again after the first is mined. The rail already refuses a proposal that no
  longer fits its chain (`409 proposal_stale`, today used when the chain was re-created); the same refusal would serve.
- **Multi-step actions need several signatures** (a deposit is two transactions; a contract-enforced policy is two
  transactions and one message), all collected before anything is sent.
- **The owner's account must hold gas** on the local chain. The rail funds it at genesis, as it does today.

## What it does and does not give

| Threat | Today | With this design |
|---|---|---|
| Code in the rail's process signs as the owner | possible | not possible: no key there |
| A stolen rail token, or a compromised backend, presents an approval | accepted if the terms hash matches | refused: no owner signature |
| The backend shows one thing and has another signed | possible | prevented only if the signer displays the terms itself |
| Malware running as the same user reads the key file | n/a (the key is derivable anyway) | still possible with a file key; a hardware wallet or secure enclave is needed |
| A coerced or mistaken owner | no delay | no delay; time-locks on protection-reducing changes are separate work (W-14) |

## How it would be verified

Tests of the same kind as `cosigner-process.test.ts`: the rail's process and environment contain no owner key; an
approval whose signature recovers another address is refused and recorded; changing one byte of the terms invalidates
the signature; an owner transaction signed for nonce n is refused after another used n; every existing test passes
with `ExternalOwner` driven by a test wallet. Moving an existing chain to the new owner uses the vault's own two-step
transfer (`transferOwnership`, `acceptOwnership`), signed once by the development key.

## Decisions needed from the owner

1. A file-key signer process for the review app, or wallet-only (which needs a wallet in the browser at review time)?
2. Passkeys need the owner to be a smart account (ERC-1271, already accepted by the vault) and one more contract that
   is not in the approved release. In scope or not?
3. May `DevelopmentOwner` remain as a labelled mode for automated tests and scripted runs?
