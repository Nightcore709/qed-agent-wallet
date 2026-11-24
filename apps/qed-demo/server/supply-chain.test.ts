/**
 * Where every dependency comes from (R13 hardening; ASVS 5.0 V15.1.2: components from pre-defined, trusted repositories).
 * Both lockfiles (the app's and the wallet service's) resolve every package from the npm registry over https, each with a
 * SHA-512 integrity hash that npm checks on install (`npm ci`). A package from anywhere else, or without its hash, fails
 * here; the check is shown able to fail on a planted entry. The CycloneDX SBOMs are in sbom/ (`npm run sbom`).
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

type Lock = { packages: Record<string, { resolved?: string; integrity?: string; link?: boolean }> }
const REGISTRY = 'https://registry.npmjs.org/'
export function untrusted(lock: Lock): string[] {
  return Object.entries(lock.packages).filter(([k, v]) => k && !v.link && (!v.resolved?.startsWith(REGISTRY) || !/^sha512-[A-Za-z0-9+/]+=*$/.test(v.integrity ?? ''))).map(([k, v]) => `${k} (${v.resolved ?? 'no source'})`)
}
const app = join(import.meta.dirname, '..')

describe('dependencies come from the npm registry, each with its SHA-512', () => {
  for (const file of ['package-lock.json', 'chain/package-lock.json']) {
    it(file, () => {
      const lock = JSON.parse(readFileSync(join(app, file), 'utf8')) as Lock
      expect(Object.keys(lock.packages).length).toBeGreaterThan(10)
      expect(untrusted(lock)).toEqual([])
    })
  }
  it('a package from elsewhere, or without its hash, is reported', () => {
    expect(untrusted({ packages: { '': {}, 'node_modules/a': { resolved: 'https://evil.example/a.tgz', integrity: 'sha512-AAAA' }, 'node_modules/b': { resolved: `${REGISTRY}b/-/b-1.0.0.tgz` } } }))
      .toEqual(['node_modules/a (https://evil.example/a.tgz)', `node_modules/b (${REGISTRY}b/-/b-1.0.0.tgz)`])
  })
})
