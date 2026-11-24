#!/bin/sh
# Regenerate the CycloneDX SBOMs and the dependency-audit records (R13 SE2).
# Uses npm's own commands only. SBOMs come from the lockfiles (--package-lock-only), so they do not depend on what
# happens to be installed. `npm audit` sends package names and versions to the npm registry; set QED_SBOM_NO_AUDIT=1
# to skip it. Writes under apps/qed-demo/sbom/ and nothing else.
set -eu
here=$(cd "$(dirname "$0")/.." && pwd)
out="$here/sbom"
mkdir -p "$out"
gen() { # name dir
  (cd "$2" && npm sbom --sbom-format cyclonedx --package-lock-only) > "$out/$1.cdx.json.tmp"
  mv "$out/$1.cdx.json.tmp" "$out/$1.cdx.json"
  echo "sbom: $out/$1.cdx.json"
}
gen qed-demo "$here"
gen qed-chain-rail "$here/chain"
if [ "${QED_SBOM_NO_AUDIT:-0}" != "1" ]; then
  for pair in "qed-demo:$here" "qed-chain-rail:$here/chain"; do
    name=${pair%%:*}; dir=${pair#*:}
    # npm audit exits 1 when it finds advisories; the record is the point, so keep going.
    (cd "$dir" && npm audit --json) > "$out/$name.audit.json" || true
    echo "audit: $out/$name.audit.json"
  done
fi
