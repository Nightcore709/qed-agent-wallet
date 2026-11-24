/**
 * Cryptographic discovery against the inventory (R13 hardening; ASVS 5.0 V11.1.2, V11.1.3): every primitive QED's own code
 * uses is in docs/crypto-inventory.json with what it is for, and every file that uses one is listed with exactly what it
 * uses. A new use of cryptography fails here until the inventory (and docs/CRYPTO.md) say what it is. The check is shown
 * able to fail: a file it has not seen, and a primitive it cannot explain, are both reported.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { compare, discover, type Inventory, primitivesIn } from '../scripts/crypto-inventory.ts'

const app = join(import.meta.dirname, '..')
const inventory = JSON.parse(readFileSync(join(app, 'docs', 'crypto-inventory.json'), 'utf8')) as Inventory

describe('the cryptographic inventory', () => {
  it('matches what the code uses, file by file', () => {
    expect(compare(discover(app), inventory)).toEqual([])
  })

  it('reports a file it has not seen and a primitive it cannot explain (the check can fail)', () => {
    const found = { ...discover(app), 'server/new-feature.ts': ['node:crypto.createHash', 'node:crypto.pbkdf2'] }
    expect(compare(found, inventory)).toEqual(['server/new-feature.ts uses node:crypto.createHash, node:crypto.pbkdf2 and is not in the inventory', 'node:crypto.pbkdf2 is used but the inventory does not say what for'])
  })

  it('reads imports in both quote styles, renamed ones, WebCrypto and the WebAuthn and noble libraries', () => {
    expect(primitivesIn(`import { createHash, randomBytes as rb, type KeyObject } from "node:crypto"\nconst x = crypto.subtle.digest\nimport { p256 } from '@noble/curves/p256'\nimport { startRegistration } from '@simplewebauthn/browser'`))
      .toEqual(['@noble/curves/p256', '@simplewebauthn/browser', 'node:crypto.KeyObject', 'node:crypto.createHash', 'node:crypto.randomBytes', 'webcrypto.subtle'])
  })
})
