# Cryptography in QED: inventory, key policy, discovery and the plan for new algorithms

Written 24 November 2026 for the R13 hardening (ASVS 5.0 V11.1.1 to V11.1.4). It describes the code on branch
`claude/r13-hardening`. The machine-readable inventory is `docs/crypto-inventory.json`; how data is sealed at rest, the key
hierarchy and the backups are in `docs/ENCRYPTION.md` (sections 3, 4 and 9), which this file does not repeat.

## 1. Inventory: algorithms, keys and where each may be used (V11.1.2)

Every algorithm comes from an established implementation: OpenSSL through `node:crypto` (Node 26.12.0, OpenSSL 3.5.9), the
platform authenticator through WebAuthn (`@simplewebauthn/server` 14.1.0 and `/browser` 14.0.0 check and drive the ceremonies),
`viem` 2.57.7 and the `noble` libraries (`@noble/curves` 1.9.1, `@noble/hashes` 1.8.0), and OpenZeppelin on chain. No
algorithm is written by hand except the browser's SHA-256 used to re-verify receipts on screen (`shared/sha256.ts`, tested
against node:crypto; ASVS V11.2.1, still Partly).

| Key or secret | Algorithm and size | Made by, held where | May be used for | Must never be used for |
|---|---|---|---|---|
| A person's passkey | ECDSA P-256 (ES256) | the person's authenticator; QED keeps only the public key (`webauthn_credentials`) | signing in; confirming a change (step-up); approving exact terms (the challenge is SHA-256 of `qed/approval/v1`, the approval's id and its terms' hash); signing a vault's EIP-712 digests, which its owner account verifies on chain (EIP-7951); signing a workspace's choice of test tokens before its vault exists (the SHA-256 of its configuration, `shared/chain-assets.ts`), which the vault service verifies as the owner account would (`chain/rail/webauthn.ts`) | anything QED's server signs: the server never holds it |
| Session token | 256 random bits | `randomBytes`; the browser's cookie; QED keeps SHA-256 of it | authenticating one session | anything else; it is never logged or returned in a body |
| CSRF token | 192 random bits | `randomBytes`; per session | proving a request came from QED's own page (compared in constant time) | authentication on its own |
| CSP nonce | 144 random bits | `randomBytes`, per page response | allowing that one page's own scripts and styles | anything stored |
| Password (D-094 accounts) | scrypt N 2^17, r 8, p 1, 32 bytes, 128-bit salt per person | the person; QED keeps the derived key | signing in, and the password-only confirmations RISK-076 allows | approving anything (approvals are passkey signatures only) |
| Saved recovery codes | 80 random bits each; scrypt N 2^14 at rest, one salt per batch; codes from before v3 are scrypt over their old SHA-256 (`scrypt-sha256`, v8 part r) | `randomBytes`; shown once | starting a recovery (with a second proof), pausing QED from the sign-in page | signing in or approving |
| Contact codes, link tokens | 80 bits (codes, scrypt at rest); link tokens of 256 bits, finishing keys of 144 (SHA-256 at rest) | `randomBytes` | one recovery step, one reset or one address confirmation, single use, short-lived | anything else |
| Approval nonce | 128 random bits | `randomBytes`, per approval | binding one approval row | a signature on its own |
| KEK (key-encryption key) | 256 bits | `randomBytes`; a key file of mode 600 outside the data folders, or `QED_KEK` | wrapping the data keys, through HKDF-SHA-256 | sealing data directly |
| Data keys (DEK), per purpose | AES-256-GCM, 96-bit random nonce, 128-bit tag | `randomBytes`; wrapped in a keyring per purpose (`database`, `backup`, `migration-copy`, `person`) | sealing data of their purpose only (the purpose and row are bound as associated data) | another purpose |
| Keyring check key | HMAC-SHA-256, from the KEK by HKDF | derived | the keyring's integrity | anything else |
| A person's export key | AES-256-GCM | `randomBytes`, per person (`person_keys`) | sealing that person's records for export and erasure | another person's data |
| Wallet service bearer token | 256 random bits | the wallet service; a file of mode 600 | the API calling the wallet service on loopback (compared in constant time) | anything a browser holds |
| Wallet service master secret | 256 random bits, sealed at rest when `QED_RAIL_SEAL=1` | the wallet service | deriving, by HKDF, each workspace's service roles (deployer, agent, guardian, relayer) on the test chain | owner authority: owners are passkey accounts |
| Co-signer keys | secp256k1 | the co-signer process, a file of mode 600 or sealed | signing certificates the vault checks; one fixed self-test text (EIP-191, R13 review fix F3) for the deployed image's isolation check | owner actions |
| Recovery key of a wallet | P-256, from the person's recovery code by scrypt (N 2^15) in the browser | the person's code, never sent | the owner account's recovery, after its delay | anything else |
| Hash chains | SHA-256 | receipts, decision records, the deny list's history | detecting a changed or missing record | secrecy |

`docs/crypto-inventory.json` lists the same by primitive, with every file that uses one; `server/crypto-inventory.test.ts`
holds it equal to the code.

## 2. Key management policy (V11.1.1), after NIST SP 800-57 Part 1 Rev. 5

- **Generation.** Every secret key comes from the operating system's CSPRNG (`crypto.randomBytes`, `crypto.getRandomValues`),
  or from an authenticator (passkeys). No key is derived from a public string (the service roles' former derivation from
  public strings was replaced by HKDF from the sealed master secret, R13 P6).
- **Storage.** Private keys of people never reach the server. Server keys are files of mode 600 in folders of mode 700, or
  sealed under the KEK; the KEK is outside the data and backup folders (`server/keys.ts` refuses otherwise). A managed key
  service or HSM is the hosted step and is not built (owner decision, `docs/ENCRYPTION.md` section 7).
- **Use.** One key, one purpose: data keys are per purpose and bind their purpose as associated data; the KEK only wraps; a
  passkey's approval signature covers one approval's exact terms.
- **Rotation.** Data keys: `node scripts/backup.ts rotate` starts a new version (and `expire` rotates when due and destroys
  keys past their window); ciphertexts name their key version. KEK: `node scripts/backup.ts rewrap` with a new one. Sessions: at most 24 hours. Passwords and passkeys: by the person. The
  wallet service's token and master secret: not rotated automatically (V13.3.4, Partly); the schedule is in `SECURITY.md`
  section 8h, "Secrets".
- **Revocation.** A passkey is suspended at once or removed after the protection delay (or at once in its first 24 hours,
  by an older passkey); sessions end on sign-out, a password change or removal, or by the operator (`server/main.ts
  sessions end`); link tokens end when their address or the password changes.
- **Destruction.** A person's export key is destroyed at erasure, which makes their sealed copies unreadable
  (`server/records.ts`); sealed backups expire on their schedule (`server/backup-retention.ts`).

## 3. Discovery (V11.1.3)

`node scripts/crypto-inventory.ts --check` reads QED's own code (server, shared, src, chain/rail, the contracts' sources and
the scripts; not tests, not the vendored release) for every use of cryptography: node:crypto by name, WebCrypto,
WebAuthn, noble, viem's key, signing and hashing functions, and Solidity signature checks. It reports any file or
primitive the inventory does not describe, and any listed file that no longer uses one. The unit suite runs it.

## 4. Quantum-resistance and the migration plan (V11.1.4)

| Use | Quantum status | Plan |
|---|---|---|
| Passkeys (ECDSA P-256), the owner account's on-chain checks | broken by a large quantum computer (Shor) | follow WebAuthn: when authenticators offer ML-DSA (FIPS 204), accept it beside ES256 (the algorithm list is one constant, `ES256` in `server/passkeys.ts`); the on-chain verifier needs a precompile or contract for it first |
| secp256k1 service roles, co-signer, EIP-712 | broken likewise | the test chain only; follows the chain's own migration |
| AES-256-GCM, HMAC-SHA-256, HKDF-SHA-256, SHA-256 hash chains, scrypt | 256-bit keys and hashes keep about 128 bits against Grover | no change needed |
| TLS (hosted profile) | key exchange at risk of "harvest now, decrypt later" | prefer the hybrid ML-KEM groups when the host's TLS offers them (OpenSSL 3.5 does: X25519MLKEM768) |

Agility points: every ciphertext names its format, algorithm and key version (`docs/ENCRYPTION.md` section 3); password
hashes name their algorithm and cost; recovery codes name theirs (`algo`); approvals name the challenge's version
(`qed/approval/v1`).
