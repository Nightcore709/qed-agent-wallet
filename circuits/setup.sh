#!/usr/bin/env bash
# Groth16 trusted setup for circuits/private_minvar.circom.
#
#   bash circuits/setup.sh            # local multi-contribution ceremony (what the testnet deployment used)
#   PTAU=path/to/pot.ptau bash ...    # reuse an existing phase-1 file, e.g. the Perpetual Powers of Tau
#
# Phase 1 (powers of tau) and phase 2 (circuit-specific) each take independent contributions and a
# final random beacon. Groth16 is sound as long as at least ONE contributor destroyed their secret.
# For this testnet prototype every contribution ran on the same machine, so the setup must be treated
# as trusted (docs/SECURITY.md, risk K18). A production deployment would take phase 1 from a public
# ceremony and run phase 2 with independent parties; the circuit, verifier and code do not change.
set -euo pipefail
cd "$(dirname "$0")"
B=build
SNARKJS="node ../node_modules/snarkjs/build/cli.cjs"
mkdir -p $B
[ -f $B/private_minvar.r1cs ] || circom private_minvar.circom --r1cs --wasm --sym -o $B

if [ -z "${PTAU:-}" ]; then
  $SNARKJS powersoftau new bn128 14 $B/pot14_0.ptau
  $SNARKJS powersoftau contribute $B/pot14_0.ptau $B/pot14_1.ptau --name="QED phase-1 contribution A" -e="$(head -c 64 /dev/urandom | base64)"
  $SNARKJS powersoftau contribute $B/pot14_1.ptau $B/pot14_2.ptau --name="QED phase-1 contribution B" -e="$(head -c 64 /dev/urandom | base64)"
  # Beacon: the hash of Sepolia transaction S4 of the clearing run (public, fixed before this setup), 2^10 iterations.
  $SNARKJS powersoftau beacon $B/pot14_2.ptau $B/pot14_beacon.ptau b69b59c99d14062acb126d36036f72850ed6671c45e11ba23bd0da04022aa654 10 -n="Beacon: Sepolia tx S4"
  $SNARKJS powersoftau prepare phase2 $B/pot14_beacon.ptau $B/pot14_final.ptau
  PTAU=$B/pot14_final.ptau
fi

$SNARKJS groth16 setup $B/private_minvar.r1cs "$PTAU" $B/private_minvar_0.zkey
$SNARKJS zkey contribute $B/private_minvar_0.zkey $B/private_minvar_1.zkey --name="QED phase-2 contribution A" -e="$(head -c 64 /dev/urandom | base64)"
$SNARKJS zkey contribute $B/private_minvar_1.zkey $B/private_minvar_2.zkey --name="QED phase-2 contribution B" -e="$(head -c 64 /dev/urandom | base64)"
# Beacon: the hash of Sepolia transaction N6 (the proven-maximal netting), 2^10 iterations.
$SNARKJS zkey beacon $B/private_minvar_2.zkey $B/private_minvar_final.zkey 46288ece141a762a1889eb8e4692b6a19719643b341e0dd31a1e4166c51a05a2 10 -n="Beacon: Sepolia tx N6"
$SNARKJS zkey verify $B/private_minvar.r1cs "$PTAU" $B/private_minvar_final.zkey
$SNARKJS zkey export verificationkey $B/private_minvar_final.zkey private_minvar.vkey.json
$SNARKJS zkey export solidityverifier $B/private_minvar_final.zkey ../contracts/src/verifiers/zk/Groth16Verifier.sol
echo "setup complete"
