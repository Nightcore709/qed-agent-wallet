#!/usr/bin/env bash
# Reproduces every file in evidence/. Local only: Forge's in-process EVM; no network, no RPC, no Anvil.
# Reads the vendored release contracts in place and never writes to them; never touches ~/qed-approved-release.
# Usage: apps/qed-demo/chain/bounties/scripts/run.sh            (add --no-deep to skip the 10,000-run profile)
# QED_EVIDENCE_DIR=evidence/<folder> writes there instead of evidence/, leaving an earlier build's evidence in place
# as history (R13: the judge allowlist's run is in evidence/r13-judges).
set -uo pipefail
cd "$(dirname "$0")/.."
export SOLC_VERSION=0.8.26 # the vendored bounties' exact pragma; foundry.toml pins solc_version too
export PATH="$HOME/.foundry/bin:$PATH"
REPO=$(cd ../../../.. && pwd)
E=${QED_EVIDENCE_DIR:-evidence}
mkdir -p "$E"
DEEP=1; [[ "${1:-}" == "--no-deep" ]] && DEEP=0

SOURCES=$(find foundry.toml src test seeded scripts -type f | LC_ALL=C sort | xargs shasum -a 256 | shasum -a 256 | cut -c1-16)
redact() { sed -e "s#$REPO#<repo>#g" -e "s#$HOME#<home>#g"; }
header() { # file, command
  {
    echo "# $2"
    echo "# recorded $(date -u +%Y-%m-%dT%H:%M:%SZ) by scripts/run.sh; sources sha256 $SOURCES"
    echo "# $(forge --version | head -1), $(forge --version | sed -n 2p)"
    echo "# solc $(forge config --json | jq -r .solc) from Foundry's compiler cache (offline = true); SOLC_VERSION=$SOLC_VERSION"
    echo
  } >"$1"
}

# 1. The main suite (unit, fuzz, differential, invariants), from a clean build.
forge clean
header "$E/forge-test.txt" "SOLC_VERSION=0.8.26 forge test -vv   (after forge clean)"
forge test -vv 2>&1 | redact >>"$E/forge-test.txt"
main_status=${PIPESTATUS[0]}
echo "# exit status: $main_status" >>"$E/forge-test.txt"

# 2. The committed artifacts against this build, and Forge's build of the judges against the release's embedded bytecode.
header "$E/artifacts-check.txt" "node scripts/export-artifacts.mjs --check"
node scripts/export-artifacts.mjs --check 2>&1 | redact >>"$E/artifacts-check.txt"
art_status=${PIPESTATUS[0]}
echo "# exit status: $art_status" >>"$E/artifacts-check.txt"

# 3. EXPECTED TO FAIL: the seeded twins and the reachability canaries (the sanity copies in seeded/Sanity.t.sol pass).
FOUNDRY_PROFILE=seeded forge clean
header "$E/forge-seeded.txt" "FOUNDRY_PROFILE=seeded SOLC_VERSION=0.8.26 forge test -vv   (EXPECTED TO FAIL; after forge clean)"
FOUNDRY_PROFILE=seeded forge test -vv 2>&1 | redact >>"$E/forge-seeded.txt"
seeded_status=${PIPESTATUS[0]}
echo "# exit status: $seeded_status (expected non-zero)" >>"$E/forge-seeded.txt"

# 4. Longer fuzzing and invariant runs (10,000 fuzz runs; 1,024 invariant runs of depth 96).
deep_status=skipped
if [[ $DEEP -eq 1 ]]; then
  header "$E/forge-deep.txt" "FOUNDRY_PROFILE=deep SOLC_VERSION=0.8.26 forge test   (fuzz 10000 runs, invariants 1024 x 96)"
  FOUNDRY_PROFILE=deep forge test 2>&1 | redact >>"$E/forge-deep.txt"
  deep_status=${PIPESTATUS[0]}
  echo "# exit status: $deep_status" >>"$E/forge-deep.txt"
fi

# 5. Slither on a copy of the board's single source. Slither 0.11.6 cannot resolve Forge 1.7.1's build of any contract
#    inheriting OpenZeppelin's EIP712 (the IERC5267 node goes missing and the contract is dropped, "0 results"), and
#    crytic-compile maps SOLC_VERSION to solc-select's folder, which holds 0.8.38 only. So the copy is compiled by
#    Foundry's own 0.8.26 binary, named by its path, with the release's settings; solc-select is not involved.
SOLC_BIN=""
for c in "$HOME/Library/Application Support/svm/0.8.26/solc-0.8.26" "$HOME/.svm/0.8.26/solc-0.8.26"; do [[ -x "$c" ]] && SOLC_BIN="$c"; done
S=$(mktemp -d)
cp src/QEDBountyBoard.sol "$S/"
OZ="$(cd ../vendor/lib/openzeppelin-contracts/contracts && pwd)"
header "$E/slither.txt" "slither QEDBountyBoard.sol --compile-force-framework solc --solc <svm 0.8.26> --solc-args '--via-ir --optimize --optimize-runs 200 --evm-version cancun'   (on a copy; see run.sh step 5)"
echo "# $(slither --version | head -1 | sed 's/^/slither /'); compiler $("$SOLC_BIN" --version | tail -1)" >>"$E/slither.txt"
(cd "$S" && env -u SOLC_VERSION slither QEDBountyBoard.sol --compile-force-framework solc --solc "$SOLC_BIN" \
  --solc-remaps "@openzeppelin/contracts/=$OZ/" --solc-args "--via-ir --optimize --optimize-runs 200 --evm-version cancun --allow-paths .,$OZ" \
  --exclude-dependencies --disable-color --json "$S/slither.json") 2>&1 | redact | sed -e "s#$S#<copy>#g" >>"$E/slither.txt"
slither_status=${PIPESTATUS[0]}
echo "# exit status: $slither_status (255 = findings reported, not a crash)" >>"$E/slither.txt"
python3 -I - "$S/slither.json" <<'EOF' | redact >>"$E/slither.txt"
import json, sys
d = json.load(open(sys.argv[1]))
mine = [r for r in d["results"]["detectors"] if any(e.get("source_mapping", {}).get("filename_short", "") == "QEDBountyBoard.sol" for e in r["elements"])]
print(f"\n# results touching QEDBountyBoard.sol: {len(mine)} (success {d['success']}); the others are in the vendored OpenZeppelin files")
for r in mine:
    print(f"#   [{r['impact']}/{r['confidence']}] {r['check']}: {r['first_markdown_element'] if 'first_markdown_element' in r else ''}")
EOF
rm -rf "$S"

# 6. What the run left behind, and the step statuses.
{
  echo "# scripts/run.sh step statuses and guards, $(date -u +%Y-%m-%dT%H:%M:%SZ); sources sha256 $SOURCES"
  echo "forge test (main) exit $main_status"
  echo "artifacts check exit $art_status"
  echo "forge test (seeded twins and canaries, expected to fail) exit $seeded_status"
  echo "forge test (deep) exit $deep_status"
  echo "slither exit $slither_status (255 = findings reported)"
  echo "tracked changes under chain/vendor (must be none): $(git status --porcelain -- ../vendor | wc -l | tr -d ' ')"
  echo "~/.solc-select/global-version present (must be no): $([[ -e "$HOME/.solc-select/global-version" ]] && echo yes || echo no)"
  echo "solc-select versions installed (unchanged by this run): $(ls "$HOME/.solc-select/artifacts" 2>/dev/null | tr '\n' ' ')"
} >"$E/run-status.txt"
cat "$E/run-status.txt"
[[ $main_status -eq 0 && $art_status -eq 0 && $seeded_status -ne 0 && ( $deep_status == skipped || $deep_status -eq 0 ) ]]
