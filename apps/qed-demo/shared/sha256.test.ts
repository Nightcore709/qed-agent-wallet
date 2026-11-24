import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { canonical, sha256 } from './sha256.ts'

describe('sha256', () => {
  it('matches FIPS 180-4 test vectors', () => {
    expect(sha256('')).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855')
    expect(sha256('abc')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad')
    expect(sha256('abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq')).toBe('248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1')
  })
  it('agrees with Node crypto on multi-byte UTF-8 and multi-block inputs', () => {
    for (const s of ['₹8,00,000', 'नमस्ते', 'x'.repeat(55), 'y'.repeat(56), 'z'.repeat(1000)]) {
      expect(sha256(s)).toBe(createHash('sha256').update(s, 'utf8').digest('hex'))
    }
  })
  it('canonical JSON ignores key order', () => {
    expect(canonical({ b: 1, a: [1, { d: 2, c: 3 }] })).toBe(canonical({ a: [1, { c: 3, d: 2 }], b: 1 }))
  })
})
