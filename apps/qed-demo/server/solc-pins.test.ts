/**
 * The Solidity compilers CI installs before forge (scripts/deploy/install-solc.sh, run by .github/workflows/qed-demo.yml)
 * are the image's (Dockerfile, the accounts stage): the same release files from binaries.soliditylang.org, pinned by the
 * same SHA-256, so GitHub checks the owner-account artifact with the compilers the deployed image builds it with.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect, it } from 'vitest'

const read = (p: string): string => readFileSync(join(import.meta.dirname, '..', p), 'utf8')

it('install-solc.sh pins the release files and SHA-256 the Dockerfile pins, and nothing else', () => {
  const image = [...read('Dockerfile').matchAll(/^ADD --checksum=sha256:([0-9a-f]{64}) https:\/\/binaries\.soliditylang\.org\/linux-amd64\/(solc-linux-amd64-v([0-9.]+)\+commit\.[0-9a-f]{8}) \/root\/\.svm\/\3\/solc-\3$/gm)]
    .map((m) => [m[3], m[2], m[1]].join(' '))
  const ci = [...read('scripts/deploy/install-solc.sh').matchAll(/^install_solc ([0-9.]+) (solc-linux-amd64-v\1\+commit\.[0-9a-f]{8}) ([0-9a-f]{64})$/gm)]
    .map((m) => [m[1], m[2], m[3]].join(' '))
  expect(image.map((l) => l.split(' ')[0]).sort()).toEqual(['0.8.26', '0.8.38'])
  expect(ci.sort()).toEqual(image.sort())
})
