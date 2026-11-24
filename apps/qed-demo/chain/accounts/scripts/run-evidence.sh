#!/usr/bin/env bash
# Reproduces every evidence file of the current build into evidence/<folder> (default r13-owner), leaving earlier
# builds' evidence in place as history. Local only: Forge's in-process EVM, Slither, and node tests whose Anvil chains
# run on 127.0.0.1 (QED_ANVIL_PORTS, default 12880-12899) and are stopped by the tests. Never a bare solc.
# Usage: apps/qed-demo/chain/accounts/scripts/run-evidence.sh [folder]
set -uo pipefail
cd "$(dirname "$0")/.."
export PATH="$HOME/.foundry/bin:$PATH"
export SOLC_VERSION=0.8.38
E="evidence/${1:-r13-owner}"
mkdir -p "$E"
REPO=$(cd ../../../.. && pwd)
redact() { sed -e "s#$REPO#<repo>#g" -e "s#$HOME#<home>#g"; }
stamp() { echo "# $1"; echo "# recorded $(date -u +%Y-%m-%dT%H:%M:%SZ); $(forge --version | head -1); src/QEDOwnerAccount.sol sha256 $(shasum -a 256 src/QEDOwnerAccount.sol | cut -c1-64)"; echo; }

{ stamp "SOLC_VERSION=0.8.38 forge test   (unit, fuzz 1000 runs seed 0x7e5a, invariants 256 x 48)"; forge test --offline 2>&1 | redact; echo "# exit status: ${PIPESTATUS[0]}"; } >"$E/forge-test.txt"
rm -f "$E/invariant-ghosts.txt"
{ stamp "FOUNDRY_INVARIANT_FAIL_ON_REVERT=true QED_GHOSTS=true forge test --match-contract AccountInvariantTest"; FOUNDRY_INVARIANT_FAIL_ON_REVERT=true QED_GHOSTS=true QED_GHOSTS_FILE="$E/invariant-ghosts.txt" forge test --offline --match-contract AccountInvariantTest 2>&1 | redact; echo "# exit status: ${PIPESTATUS[0]}"; } >"$E/forge-invariants-fail-on-revert.txt"
{ stamp "FOUNDRY_PROFILE=seeded forge test   (EXPECTED TO FAIL: each twin its own invariant)"; FOUNDRY_PROFILE=seeded forge test --offline 2>&1 | redact; echo "# exit status: ${PIPESTATUS[0]} (expected non-zero)"; } >"$E/forge-seeded-twin.txt"
# --force: a build that finds nothing changed prints no size table (R13 review fixes: the first run's file was empty)
{ stamp "forge build --sizes --force"; forge build --offline --sizes --force 2>&1 | redact; } >"$E/forge-build-sizes.txt"
{ stamp "forge test --gas-report --match-contract 'GuardianTest|TimeLockTest|ContainmentTest|ReviewFixesTest'"; forge test --offline --gas-report --match-contract 'GuardianTest|TimeLockTest|ContainmentTest|ReviewFixesTest' 2>&1 | redact; } >"$E/forge-gas-report.txt"
# node tests before Slither: Slither's forced build skips test/, which removes the release artifacts they read
{ stamp "node --test --test-concurrency=1 test-ts/"; QED_EVIDENCE_DIR="$E" QED_ANVIL_PORTS="${QED_ANVIL_PORTS:-12880-12899}" node --test --test-concurrency=1 test-ts/ 2>&1 | redact; echo "# exit status: ${PIPESTATUS[0]}"; } >"$E/node-test.txt"
rm -f "$E/slither.json"
{ stamp "slither . --exclude-dependencies --json $E/slither.json   (exit 255 = findings reported)"; slither . --exclude-dependencies --json "$E/slither.json" --disable-color 2>&1 | redact; echo "# exit status: ${PIPESTATUS[0]}"; } >"$E/slither.txt"
node ../node_modules/typescript/bin/tsc -p tsconfig.json >"$E/tsc.txt" 2>&1; echo "# tsc exit status: $?" >>"$E/tsc.txt"
echo "evidence written to $E"
