/**
 * A software passkey authenticator for tests and evidence scripts. It produces exactly the JSON a browser hands to
 * the page after navigator.credentials.create() and .get() (RegistrationResponseJSON, AuthenticationResponseJSON),
 * signed with a P-256 key it holds in memory. Never used by the application itself: in a browser the platform
 * authenticator (Touch ID, Face ID, Windows Hello, a security key) does this, and the key never leaves it.
 */
import { createHash, createSign, generateKeyPairSync, type KeyObject, randomBytes } from 'node:crypto'
import { isoCBOR } from '@simplewebauthn/server/helpers'

const b64u = (b: Uint8Array | Buffer): string => Buffer.from(b).toString('base64url')
const sha256 = (b: Uint8Array | Buffer | string): Buffer => createHash('sha256').update(b).digest()

export interface SoftOptions { origin: string; rpId?: string; userVerified?: boolean; userPresent?: boolean }

export class SoftAuthenticator {
  readonly credentialId: Buffer = randomBytes(32)
  private readonly key: KeyObject
  readonly x: Buffer
  readonly y: Buffer
  private counter = 0
  userHandle = ''
  private readonly opts: SoftOptions
  constructor(opts: SoftOptions) {
    this.opts = opts
    const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' })
    this.key = privateKey
    const jwk = publicKey.export({ format: 'jwk' }) as { x: string; y: string }
    this.x = Buffer.from(jwk.x, 'base64url'); this.y = Buffer.from(jwk.y, 'base64url')
  }

  get id(): string { return b64u(this.credentialId) }

  private flags(attested: boolean): number {
    return (this.opts.userPresent === false ? 0 : 0x01) | (this.opts.userVerified === false ? 0 : 0x04) | (attested ? 0x40 : 0)
  }
  private rpIdHash(rpId?: string): Buffer { return sha256(rpId ?? this.opts.rpId ?? 'localhost') }

  /** The browser's answer to navigator.credentials.create(options). */
  create(options: { challenge: string; user: { id: string }; rp: { id?: string } }, overrides: { origin?: string } = {}): Record<string, unknown> {
    this.userHandle = options.user.id
    const clientDataJSON = Buffer.from(JSON.stringify({ type: 'webauthn.create', challenge: options.challenge, origin: overrides.origin ?? this.opts.origin, crossOrigin: false }))
    const coseKey = new Map<number, number | Uint8Array>([[1, 2], [3, -7], [-1, 1], [-2, new Uint8Array(this.x)], [-3, new Uint8Array(this.y)]])
    const cred = Buffer.concat([Buffer.alloc(16), Buffer.from([0, this.credentialId.length]), this.credentialId, Buffer.from(isoCBOR.encode(coseKey as never))])
    const authData = Buffer.concat([this.rpIdHash(options.rp.id), Buffer.from([this.flags(true)]), Buffer.alloc(4), cred])
    const attestationObject = isoCBOR.encode(new Map<string, unknown>([['fmt', 'none'], ['attStmt', new Map()], ['authData', new Uint8Array(authData)]]) as never)
    return {
      id: this.id, rawId: this.id, type: 'public-key', authenticatorAttachment: 'platform', clientExtensionResults: {},
      response: { clientDataJSON: b64u(clientDataJSON), attestationObject: b64u(attestationObject), transports: ['internal'] },
    }
  }

  /** The browser's answer to navigator.credentials.get(options). */
  get(options: { challenge: string; rpId?: string }, overrides: { origin?: string; type?: string } = {}): Record<string, unknown> {
    this.counter++
    const clientDataJSON = Buffer.from(JSON.stringify({ type: overrides.type ?? 'webauthn.get', challenge: options.challenge, origin: overrides.origin ?? this.opts.origin, crossOrigin: false }))
    const count = Buffer.alloc(4); count.writeUInt32BE(this.counter)
    const authData = Buffer.concat([this.rpIdHash(options.rpId), Buffer.from([this.flags(false)]), count])
    const signer = createSign('SHA256'); signer.update(Buffer.concat([authData, sha256(clientDataJSON)]))
    const signature = signer.sign(this.key) // DER, as browsers send it
    return {
      id: this.id, rawId: this.id, type: 'public-key', authenticatorAttachment: 'platform', clientExtensionResults: {},
      response: { clientDataJSON: b64u(clientDataJSON), authenticatorData: b64u(authData), signature: b64u(signature), userHandle: this.userHandle },
    }
  }
}
