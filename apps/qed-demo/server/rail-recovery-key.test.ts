/**
 * The on-chain wallet's recovery key as the browser makes it (src/lib/passkey.ts, with @noble/hashes and @noble/curves):
 * the same key as chain/accounts/webauthn.ts RecoveryKey for the same code (a vector that class produced), codes in the
 * account's format from the device's random source, and signatures that P-256 verification accepts over exactly the
 * bytes signed, with s in the low form the account requires.
 */
import { createPublicKey, verify } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { newRecoveryCode, normaliseRecoveryCode, recoveryKeyFrom } from '../src/lib/passkey.ts'

// produced by chain/accounts/webauthn.ts: new RecoveryKey('01234-56789-abcde-fghjk-mnpqrs')
const VECTOR = { code: '01234-56789-abcde-fghjk-mnpqrs', x: '0xd5d4178e828ae16fe913e70c71e5605dacda326ec2dd341bf3f037648d2f97a4', y: '0x24f433afed37b7fed101df247b7d82f014811b5266ffbbae7f33da0ff39176ef' }
const N = 0xffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551n
const keyObject = (k: { x: string; y: string }) => createPublicKey({ key: { kty: 'EC', crv: 'P-256', x: Buffer.from(k.x.slice(2), 'hex').toString('base64url'), y: Buffer.from(k.y.slice(2), 'hex').toString('base64url') }, format: 'jwk' })

describe('the recovery key made in the browser', () => {
  it('is the key chain/accounts derives from the same code, however the code is typed', async () => {
    expect((await recoveryKeyFrom(VECTOR.code)).publicKey).toEqual({ x: VECTOR.x, y: VECTOR.y })
    expect((await recoveryKeyFrom(' 0I234 56789 ABCDE FGHJK MNPQRS ')).publicKey.x).toBe(VECTOR.x)
    await expect(recoveryKeyFrom('ABCDE-FGHJK')).rejects.toMatchObject({ code: 'recovery_code_format' })
  }, 20_000)

  it('makes codes of 26 Crockford base-32 characters grouped 5-5-5-5-6, never the same twice', () => {
    const codes = Array.from({ length: 50 }, () => newRecoveryCode())
    for (const c of codes) { expect(c).toMatch(/^[0-9A-HJKMNP-TV-Z]{5}(-[0-9A-HJKMNP-TV-Z]{5}){3}-[0-9A-HJKMNP-TV-Z]{6}$/); expect(normaliseRecoveryCode(c)).toBe(c.replace(/-/g, '')) }
    expect(new Set(codes).size).toBe(50)
  })

  it('signs exactly the bytes it is given (ECDSA P-256, SHA-256), with s in the low form', async () => {
    const k = await recoveryKeyFrom(VECTOR.code)
    const digest = `0x${'5a'.repeat(32)}`
    for (let i = 0; i < 5; i++) {
      const sig = k.sign(digest)
      expect(BigInt(sig.s) <= N / 2n).toBe(true)
      expect(verify('sha256', Buffer.from(digest.slice(2), 'hex'), { key: keyObject(k.publicKey), dsaEncoding: 'ieee-p1363' }, Buffer.from(sig.r.slice(2) + sig.s.slice(2), 'hex'))).toBe(true)
      expect(verify('sha256', Buffer.from(`0x${'5b'.repeat(32)}`.slice(2), 'hex'), { key: keyObject(k.publicKey), dsaEncoding: 'ieee-p1363' }, Buffer.from(sig.r.slice(2) + sig.s.slice(2), 'hex'))).toBe(false)
    }
  }, 20_000)
})
