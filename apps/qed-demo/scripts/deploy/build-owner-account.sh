#!/usr/bin/env sh
# Builds the wallet service's owner-account contract (chain/accounts) exactly as chain/accounts/READY.json declares it,
# and stops unless the artifact's SHA-256 equals the declared one (docs/DEPLOY.md, "Clean checkout").
#
#   scripts/deploy/build-owner-account.sh            build if needed, then check
#   FORGE_OFFLINE=1 scripts/deploy/build-owner-account.sh    never touch the network (solc 0.8.38 already in forge's cache)
#
# Why these two files: out/ is not in git, and the wallet service uses the artifact only when its SHA-256 matches
# READY.json (chain/rail/owner.ts). The artifact records the compiler's AST node ids (deployedBytecode.immutableReferences),
# which depend on the set of files compiled together, so `forge build` of the whole project gives the same bytecode but a
# different file. READY.json's artifact is compiled with src/QEDOwnerAccount.sol and test/Invariant.t.sol; compiling that
# set again reproduces it byte for byte (checked on 24 Nov 2026 from a fresh clone at another path for the artifact of that
# day; for the R13 review fixes of 25 Nov 2026, SHA-256 8b0beb8e..., checked from cleared out/ and cache/ folders and from a
# copy at another path, chain/accounts/evidence/r13-secfix/reproducible-build.txt). Needs forge from Foundry v1.7.1 and solc 0.8.38 (forge downloads it into its cache
# and checks it against the compiler list when online). Never a bare solc: SOLC_VERSION is set for the one command.
set -eu
here=$(cd "$(dirname "$0")" && pwd)
cd "$here/../../chain/accounts"
artifact=out/QEDOwnerAccount.sol/QEDOwnerAccount.json
# sha256sum (Linux, the Foundry image) or shasum (macOS); no Node needed, so the image's Foundry stage can run it
sha() { if command -v sha256sum >/dev/null 2>&1; then sha256sum "$1" | cut -d' ' -f1; else shasum -a 256 "$1" | cut -d' ' -f1; fi; }
want=$(sed -n 's/.*"artifactSha256": *"\([0-9a-f]\{64\}\)".*/\1/p' READY.json)
[ -n "$want" ] || { echo "READY.json declares no artifactSha256" >&2; exit 1; }
if [ -f "$artifact" ] && [ "$(sha "$artifact")" = "$want" ]; then echo "owner-account artifact already built and matches READY.json ($want)"; exit 0; fi
command -v forge >/dev/null 2>&1 || { echo "forge (Foundry v1.7.1) is not on PATH; install it (docs/DEPLOY.md, Prerequisites)" >&2; exit 1; }
version=$(forge --version | head -1)
case "$version" in *" 1.7.1"*) ;; *) echo "warning: $version is not Foundry 1.7.1, the version READY.json's artifact was built with; the hash check below decides" >&2 ;; esac
SOLC_VERSION=0.8.38 forge build --force ${FORGE_OFFLINE:+--offline} src/QEDOwnerAccount.sol test/Invariant.t.sol
have=$(sha "$artifact")
if [ "$have" != "$want" ]; then echo "owner-account artifact SHA-256 $have does not match READY.json's $want; the wallet service would refuse it" >&2; exit 1; fi
echo "owner-account artifact built; SHA-256 $have matches READY.json"
