#!/usr/bin/env sh
# Installs the two Solidity compilers chain/accounts needs (0.8.38; 0.8.26 for the release's vendored QEDVault) from the
# official release binaries, each checked against the SHA-256 the Dockerfile pins (read from
# binaries.soliditylang.org/linux-amd64/list.json on 25 Nov 2026), at ~/.svm/<version>/solc-<version>, where forge looks
# for installed compilers when ~/.svm exists. forge then runs offline (forge test --offline;
# FORGE_OFFLINE=1 scripts/deploy/build-owner-account.sh), as in the image build: forge's own download of 0.8.38 failed on
# GitHub's ubuntu-24.04 runner and in the image build ("No solc version exists that matches =0.8.38", 25 Nov 2026).
#
#   scripts/deploy/install-solc.sh      used by .github/workflows/qed-demo.yml before every forge step
#
# Linux x86-64 only (GitHub's runner, the image's platform). It refuses to run elsewhere: on macOS forge keeps its
# compilers in ~/Library/Application Support/svm, and creating ~/.svm would move forge to an empty folder.
# server/solc-pins.test.ts holds these pins equal to the Dockerfile's. Never a bare solc: SOLC_VERSION is set for the one
# command that runs one.
set -eu
platform="$(uname -s)-$(uname -m)"
[ "$platform" = "Linux-x86_64" ] || { echo "install-solc.sh installs the linux-amd64 compilers; this is $platform. Nothing was installed." >&2; exit 1; }
svm="$HOME/.svm"
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT

# install_solc <version> <release file> <SHA-256>
install_solc() {
  dest="$svm/$1/solc-$1"
  if [ -f "$dest" ] && [ "$(sha256sum "$dest" | cut -d' ' -f1)" = "$3" ]; then
    echo "solc $1 already at $dest and matches its pin"
  else
    curl --fail --silent --show-error --location --proto '=https' --tlsv1.2 --retry 3 --output "$tmp/solc-$1" "https://binaries.soliditylang.org/linux-amd64/$2"
    have=$(sha256sum "$tmp/solc-$1" | cut -d' ' -f1)
    [ "$have" = "$3" ] || { echo "solc $1 ($2): SHA-256 $have, pinned $3. Not installed." >&2; exit 1; }
    mkdir -p "$svm/$1"
    install -m 0755 "$tmp/solc-$1" "$dest"
    echo "solc $1 installed at $dest (SHA-256 $3)"
  fi
  # the compiler runs here (captured first: a pipe would hide its failure)
  ran=$(SOLC_VERSION="$1" "$dest" --version)
  printf '%s\n' "$ran" | tail -1
}

install_solc 0.8.38 solc-linux-amd64-v0.8.38+commit.1835d247 65c3180a336eabb6bdc4bbd49cc405aeb233976964ae6c11fba2a6c8be8f3243
install_solc 0.8.26 solc-linux-amd64-v0.8.26+commit.8a97fa7a d5f23436f443edb85d8e76906d12f0a86ce0490e7663a9e608efeb7a93f149ef
