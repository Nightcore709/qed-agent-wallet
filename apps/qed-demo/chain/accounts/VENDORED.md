# Third-party code used by `accounts/`

Recorded 20 Nov 2026. Every file listed under "Vendored" is byte-for-byte what was downloaded; none is modified.

## Vendored: OpenZeppelin Contracts 5.6.1 (13 Solidity files and the licence)

| | |
|---|---|
| Directory | `lib/openzeppelin-contracts-5.6.1/` (relative paths kept, so OpenZeppelin's own relative imports resolve) |
| Source | npm registry, `npm pack @openzeppelin/contracts@5.6.1` (registry.npmjs.org, latest dist-tag on 20 Nov 2026) |
| Tarball | `openzeppelin-contracts-5.6.1.tgz`, SHA-256 `bd202ef9a2fd09f6005edc18437b4d3090841d0f676c01c814ee9608581d2e63`, npm integrity `sha512-Ly6SlsVJ3mj+b18W3R8gNufB7dTICT105fJhodGAGgyC2oqnBAhqSiNDJ8V8DLY05cCz81GLI0CU5vNYA1EC/w==` (recomputed locally: equal) |
| Cross-check | each of the 13 files is byte-identical to `https://raw.githubusercontent.com/OpenZeppelin/openzeppelin-contracts/v5.6.1/contracts/<path>` (fetched 20 Nov 2026) |
| Licence | MIT. `LICENSE` fetched from the same tag (`v5.6.1/LICENSE`); the npm tarball does not contain it. "Copyright (c) 2016-2026 Zeppelin Group Ltd" |
| Install scripts | `package.json` declares `prepack` and `prepare-docs` only; neither runs when a registry tarball is downloaded, and nothing was installed (files were copied out of the extracted tarball). No runtime dependencies. |
| Why these files | the import closure of `utils/cryptography/WebAuthn.sol` and `utils/ReentrancyGuardTransient.sol`, computed by following every `import` |

| File | Last changed in | SHA-256 |
|---|---|---|
| `LICENSE` | | `20aebc68b11c063133aa2af0ef4bb29875477c6d16d715718f0daec563938b84` |
| `utils/Base64.sol` | v5.6.0 | `1c143572893f50f04fe8e507d89f9997cd3242102ba4200c8de0803ecbaf8cec` |
| `utils/Bytes.sol` | v5.6.0 | `3ce9120a27934c75a074cb785d3a88868069ef6529dbe4dc6b845af0836f3c70` |
| `utils/Errors.sol` | v5.1.0 | `0704b9d6c032cca8512a3bc3f30f49f86f1f03102d2896a3d23e794b82efea66` |
| `utils/Panic.sol` | v5.1.0 | `270fc8401c1a13fae6a7a4a2dd6e381b95d658896701e51f0d3e2688acab3dec` |
| `utils/ReentrancyGuardTransient.sol` | v5.5.0 | `cff7c20aed945d939b764d876adbd42e1b7725d62d5b1f2bd303db237567b575` |
| `utils/StorageSlot.sol` | v5.1.0 | `75704538dcb223239280c6726d9a31cf769a7816718517c997fc7d63bdb70778` |
| `utils/Strings.sol` | v5.6.0 | `e318709bbe73a7831d64c1351e8bdc43780b245f25191234e361e6ab9b98c67b` |
| `utils/TransientSlot.sol` | v5.3.0 | `ea92f361d697ba8b1fbd322b4d84b989998862c21fbebfa4b45289dc94a9eea2` |
| `utils/cryptography/P256.sol` | v5.3.0 | `0d7bb2f2b5e0ceb0e1a28523ee179c1aee5980cb793df739dd9ccf87170dffe2` |
| `utils/cryptography/WebAuthn.sol` | v5.6.0 | `b0291b551fcc38e468ae0bab750fe9f1aba33dfd563dc75eb3d17f17532c0e78` |
| `utils/math/Math.sol` | v5.6.0 | `bdfdbe133991c0c78042957ff5cd97167926fcaf6d15664f3835a076cb066457` |
| `utils/math/SafeCast.sol` | v5.6.0 | `5779bc848bde39f1ad7bc02b4f708a0040888e0083b1a33f119cd94639350134` |
| `utils/math/SignedMath.sol` | v5.1.0 | `1ed50b1056af886752f0fb48a0165d381e69bb4a4b18b893b066dc144a7e08d7` |

Verify: `cd lib/openzeppelin-contracts-5.6.1 && shasum -a 256 LICENSE $(find utils -name '*.sol' | sort)`.

**Audit coverage (from OpenZeppelin's `audits/README.md` at tag v5.6.1, fetched 20 Nov 2026).** Listed audits:
v5.3 changes (April 2025), v5.4 changes (July 2025), v5.5 limited to SafeERC20, ECDSA and SignatureChecker
(October 2025); none for 5.6. Consequences for the files used here:
- `P256.sol` (last changed 5.3.0, the precompile-detection fix "consider empty returndata on invalid
  verification", PR #5620) falls inside the v5.3 audit as listed. This is the file that verifies every signature.
- `WebAuthn.sol` first appeared in 5.5.0 (PR #5809) and changed in 5.6.0 (out-of-bounds `challengeIndex` now returns
  false instead of reverting, PR #6329). It is **not** inside any listed audit scope. Its logic is a port of the
  Daimo and Base implementations (its own header says so); Base's `webauthn-sol` was reviewed by Cantina (report
  dated 7 Mar 2024 in that repository). It was read line by line for this work and every rejection path it
  implements has a test here (`test/Verifier.t.sol`).
- `Base64.sol`, `Bytes.sol`, `Strings.sol`, `Math.sol`, `SafeCast.sol` last changed in 5.6.0: not inside a listed
  audit at their current text. **NOT VERIFIED** beyond reading the parts on the verification path and the tests.

## Reviewed and not used: base/webauthn-sol

`https://github.com/base/webauthn-sol` at `619f20ab0f074fef41066ee4ab24849a913263b2` (HEAD on 20 Nov 2026; MIT;
tarball SHA-256 `f1b7dbf9af2e6dada3667217d69981cacd597ab625d5012f9caeb362a17ce314`) was downloaded to a scratch
directory for review only and is **not** vendored. Its `src/WebAuthn.sol` calls the precompile and, whenever the
output is empty, verifies again with FreshCryptoLib (its own comment: "even if precompile exists, ret.length is 0
when verification returns false so an invalid signature will be checked twice: once by the precompile and once by
FCL"). On a chain that has the precompile every forged signature would therefore also be judged by FreshCryptoLib,
which contradicts the brief's fail-closed rule and adds three dependencies (FreshCryptoLib, solady, OpenZeppelin).

## Used in place, read-only (not copied, not modified)

| What | Path | SHA-256 | Provenance |
|---|---|---|---|
| The release's `QEDVault.sol` | `../vendor/contracts/src/QEDVault.sol` | `c9a4801ed5624e2581a2d8386248a15b69660a6b52be7496d4405c2d055fafd8` | `../VENDORED.json` records the same hash with `releaseManifest: match` for release `qed-20261023-health-gate-v3` (agent-recorded; not re-checked against `~/qed-approved-release`, which this work does not touch) |
| The release's `TestUSD.sol` | `../vendor/contracts/src/TestUSD.sol` | `e7e6216921dab6cbe54ce88d0ccbd0585d1f39b9695a3d3d659aa539a95f3dfa` | as above |
| The release's `QEDExecution.sol` | `../vendor/contracts/src/QEDExecution.sol` | `ed5741578dffd3eefc28e0ad8b1b604586631f2c6642435e0b9e0bdb87632e3b` | as above (same hash in `../VENDORED.json`) |
| The release's `QEDTreasuryPolicy.sol` | `../vendor/contracts/src/QEDTreasuryPolicy.sol` | `18a33316c812b941a8d5ebdcb2273785dc40c6b86f3bca21e7b9636105c64b53` | as above (same hash in `../VENDORED.json`) |
| Release creation bytecode | `../vendor/agent/src/abi/contracts.ts` | `5099b36437fe2485b309d9890ba62505a110fc62b37c4c74b00435986adef4a1` | as above; the Anvil test deploys QEDVault, TestUSD, QEDExecution and QEDTreasuryPolicy from these bytes, and checks our build of the four sources above is byte-identical to them |
| OpenZeppelin Contracts 5.1.0 (the vault's imports) | `../vendor/lib/openzeppelin-contracts/` | `package.json`: `c57ecc49cdadc103b019cf7617c9415d9678c85f329792bb7518a19786a4a23d` | release submodule `69c8def5`, per `../vendor/foundry.lock` |
| forge-std 1.9.7 (tests only) | `../vendor/lib/forge-std/` | `package.json`: `0796872cc211ddb564546125b3d516bdf70f7be6a925d140ad9922ed0030a0a7` | release submodule `77041d2c`, per `../vendor/foundry.lock` |
| viem 2.57.7 (one TypeScript test only: an independent EIP-712 check) | `../node_modules/viem` | n/a | installed by the chain rail's own lockfile; not installed or changed by this work; MIT |
| TypeScript 5.6.3, @types/node 22.10.2 (type check only) | `../node_modules/` | n/a | same; Apache-2.0 / MIT |

`webauthn.ts` itself imports only `node:crypto` (Keccak-256 comes from OpenSSL 3.5 through `node:crypto`).
