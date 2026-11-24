/**
 * Client side of QEDOwnerAccount (src/QEDOwnerAccount.sol). node:crypto only; runs directly on Node >= 22.18
 * (type stripping) and needs an OpenSSL that provides keccak-256 (Node 26 with OpenSSL 3.5 does).
 *
 *  (i)   challenges the contract expects: executeDigest, replaySafeHash (ERC-1271), cancelDigest, recoveryDigest;
 *  (ii)  a browser PublicKeyCredential assertion (authenticatorData, clientDataJSON, DER signature) turned into the
 *        contract's Assertion and calldata, with s normalised to the low half and every on-chain rule checked first;
 *  (iii) a software authenticator for tests (P-256 key, authenticatorData with flags, clientDataJSON) and the
 *        recovery-code key (raw P-256, ECDSA/SHA-256, derived from a 128-bit code with scrypt);
 *  (iv)  the guarded-call list for a workspace's vault set and the delayed path (scheduleCalls / applyCalls).
 *
 * The client must compute challenges itself from the terms it shows, never accept a challenge from a server.
 */
import {
  createECDH,
  createHash,
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  randomBytes,
  scryptSync,
  sign as nodeSign,
  verify as nodeVerify,
} from 'node:crypto';
import type { KeyObject } from 'node:crypto';

export type Hex = `0x${string}`;

// ── constants ─────────────────────────────────────────────────────────────────────

export const P256_N = 0xffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551n;
/** floor(n/2): the contract (OpenZeppelin P256) accepts s in [1, P256_HALF_N] only. */
export const P256_HALF_N = P256_N / 2n;
export const FLAG_UP = 0x01;
export const FLAG_UV = 0x04;
export const FLAG_BE = 0x08;
export const FLAG_BS = 0x10;
export const ERC1271_MAGIC: Hex = '0x1626ba7e';
export const ERC1271_INVALID: Hex = '0xffffffff';

/** R13: Guardian (3) is set only through setGuardian, behind the account's delay; addSigner and the constructor refuse it. */
export const Role = { None: 0, Member: 1, Recovery: 2, Guardian: 3 } as const;
export type RoleValue = (typeof Role)[keyof typeof Role];

const ASSERTION_TUPLE = '(bytes32,bytes32,bytes32,uint256,uint256,uint256,bytes,string)';
const CALL_TUPLE = '(address,uint256,bytes)';

// ── bytes, hex, hashes ────────────────────────────────────────────────────────────

const utf8 = (s: string): Uint8Array => new TextEncoder().encode(s);

export function hexToBytes(h: string): Uint8Array {
  if (!/^0x([0-9a-fA-F]{2})*$/.test(h)) throw new Error(`not an even-length 0x hex string: ${h.slice(0, 20)}`);
  return Uint8Array.from(Buffer.from(h.slice(2), 'hex'));
}

export function bytesToHex(b: Uint8Array): Hex {
  return `0x${Buffer.from(b).toString('hex')}`;
}

export function toBytes(v: Uint8Array | ArrayBuffer | Hex): Uint8Array {
  if (typeof v === 'string') return hexToBytes(v);
  return v instanceof Uint8Array ? v : new Uint8Array(v);
}

export function concat(...parts: Uint8Array[]): Uint8Array {
  return Uint8Array.from(Buffer.concat(parts));
}

export function keccak256(b: Uint8Array | string): Uint8Array {
  return new Uint8Array(createHash('keccak-256').update(typeof b === 'string' ? utf8(b) : b).digest());
}

export function sha256(b: Uint8Array | string): Uint8Array {
  return new Uint8Array(createHash('sha256').update(typeof b === 'string' ? utf8(b) : b).digest());
}

export function bigToBytes32(v: bigint): Uint8Array {
  if (v < 0n || v >= 1n << 256n) throw new Error(`out of uint256 range: ${v}`);
  return hexToBytes(`0x${v.toString(16).padStart(64, '0')}`);
}

export function bytesToBig(b: Uint8Array): bigint {
  return b.length === 0 ? 0n : BigInt(bytesToHex(b));
}

export function base64url(b: Uint8Array): string {
  return Buffer.from(b).toString('base64url'); // RFC 4648 section 5, no padding (as WebAuthn and the contract)
}

// ── minimal ABI encoder (standard head/tail encoding) ─────────────────────────────

type AbiType = { kind: 'elem'; name: string } | { kind: 'array'; inner: AbiType } | { kind: 'tuple'; comps: AbiType[] };

function splitTop(s: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let cur = '';
  for (const ch of s) {
    if (ch === '(') depth++;
    if (ch === ')') depth--;
    if (ch === ',' && depth === 0) {
      out.push(cur);
      cur = '';
    } else cur += ch;
  }
  if (cur !== '') out.push(cur);
  return out;
}

function parseType(t: string): AbiType {
  if (t.endsWith('[]')) return { kind: 'array', inner: parseType(t.slice(0, -2)) };
  if (t.startsWith('(')) {
    if (!t.endsWith(')')) throw new Error(`bad tuple type ${t}`);
    return { kind: 'tuple', comps: splitTop(t.slice(1, -1)).map(parseType) };
  }
  if (!/^(uint(8|16|32|64|128|256)|address|bool|bytes([1-9]|[12][0-9]|3[0-2])?|string)$/.test(t)) {
    throw new Error(`unsupported ABI type ${t}`);
  }
  return { kind: 'elem', name: t };
}

function isDynamic(t: AbiType): boolean {
  if (t.kind === 'elem') return t.name === 'bytes' || t.name === 'string';
  if (t.kind === 'array') return true;
  return t.comps.some(isDynamic);
}

function padRight(b: Uint8Array): Uint8Array {
  const len = Math.ceil(b.length / 32) * 32;
  const out = new Uint8Array(len);
  out.set(b);
  return out;
}

function encodeElem(name: string, v: unknown): Uint8Array {
  if (name.startsWith('uint')) {
    const bits = BigInt(name.slice(4));
    const n = BigInt(v as bigint | number | string);
    if (n < 0n || n >= 1n << bits) throw new Error(`${name} out of range: ${n}`);
    return bigToBytes32(n);
  }
  if (name === 'address') {
    const b = hexToBytes(v as string);
    if (b.length !== 20) throw new Error(`address must be 20 bytes: ${v}`);
    return concat(new Uint8Array(12), b);
  }
  if (name === 'bool') return bigToBytes32(v ? 1n : 0n);
  if (name === 'bytes' || name === 'string') {
    const data = v instanceof Uint8Array ? v : name === 'string' ? utf8(v as string) : hexToBytes(v as string);
    return concat(bigToBytes32(BigInt(data.length)), padRight(data));
  }
  const size = Number(name.slice(5)); // bytesN
  const b = toBytes(v as Hex | Uint8Array);
  if (b.length !== size) throw new Error(`${name} must be ${size} bytes`);
  return padRight(b);
}

function encodeOne(t: AbiType, v: unknown): Uint8Array {
  if (t.kind === 'elem') return encodeElem(t.name, v);
  if (t.kind === 'array') {
    const arr = v as unknown[];
    return concat(bigToBytes32(BigInt(arr.length)), encodeTuple(arr.map(() => t.inner), arr));
  }
  return encodeTuple(t.comps, v as unknown[]);
}

function encodeTuple(types: AbiType[], values: unknown[]): Uint8Array {
  if (types.length !== values.length) throw new Error(`ABI arity: ${types.length} types, ${values.length} values`);
  const encoded = types.map((t, i) => encodeOne(t, values[i]));
  const headLen = types.reduce((sum, t, i) => sum + (isDynamic(t) ? 32 : encoded[i].length), 0);
  const heads: Uint8Array[] = [];
  const tails: Uint8Array[] = [];
  let offset = headLen;
  types.forEach((t, i) => {
    if (isDynamic(t)) {
      heads.push(bigToBytes32(BigInt(offset)));
      tails.push(encoded[i]);
      offset += encoded[i].length;
    } else heads.push(encoded[i]);
  });
  return concat(...heads, ...tails);
}

/** abi.encode(values) for the given canonical types, e.g. ['uint256', '(address,uint256,bytes)[]']. */
export function abiEncode(types: string[], values: unknown[]): Uint8Array {
  return encodeTuple(types.map(parseType), values);
}

export function selector(signature: string): Uint8Array {
  return keccak256(signature).slice(0, 4);
}

/** Calldata for `signature` (canonical, e.g. "transfer(address,uint256)"). */
export function encodeCall(signature: string, values: unknown[] = []): Hex {
  const inner = signature.slice(signature.indexOf('(') + 1, -1);
  return bytesToHex(concat(selector(signature), abiEncode(splitTop(inner), values)));
}

// ── EIP-712 challenges (must equal the contract's views) ──────────────────────────

export const TYPEHASH = {
  domain: keccak256('EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)'),
  call: keccak256('Call(address target,uint256 value,bytes data)'),
  execute: keccak256('Execute(Call[] calls,uint256 nonce,uint64 deadline)Call(address target,uint256 value,bytes data)'),
  message: keccak256('QEDOwnerMessage(bytes32 hash)'),
  cancel: keccak256('Cancel(bytes32 id)'),
  startRecovery: keccak256('StartRecovery(bytes32 recoverySignerId,uint256 newX,uint256 newY,uint64 deadline)'),
};

export interface Call {
  target: Hex;
  value: bigint;
  data: Hex;
}

export function domainSeparator(account: Hex, chainId: bigint): Hex {
  return bytesToHex(
    keccak256(
      abiEncode(
        ['bytes32', 'bytes32', 'bytes32', 'uint256', 'address'],
        [TYPEHASH.domain, keccak256('QEDOwnerAccount'), keccak256('1'), chainId, account],
      ),
    ),
  );
}

/** keccak256("\x19\x01" || domainSeparator || structHash) for any EIP-712 domain separator. */
export function typedDataDigest(domainSep: Hex, structHash: Uint8Array): Hex {
  return bytesToHex(keccak256(concat(Uint8Array.of(0x19, 0x01), hexToBytes(domainSep), structHash)));
}

/** EIP-712 array hash of Call structs; also the hash a scheduled batch is stored under (`callsHash` view). */
export function callsHash(calls: Call[]): Hex {
  const callHashes = calls.map((c) =>
    keccak256(abiEncode(['bytes32', 'address', 'uint256', 'bytes32'], [TYPEHASH.call, c.target, c.value, keccak256(hexToBytes(c.data))])),
  );
  return bytesToHex(keccak256(concat(...callHashes)));
}

export function executeDigest(p: { account: Hex; chainId: bigint; calls: Call[]; nonce: bigint; deadline: bigint }): Hex {
  const structHash = keccak256(
    abiEncode(['bytes32', 'bytes32', 'uint256', 'uint64'], [TYPEHASH.execute, callsHash(p.calls), p.nonce, p.deadline]),
  );
  return typedDataDigest(domainSeparator(p.account, p.chainId), structHash);
}

/** The challenge Members sign for an ERC-1271 `hash` (binds account and chain). */
export function replaySafeHash(p: { account: Hex; chainId: bigint; hash: Hex }): Hex {
  return typedDataDigest(domainSeparator(p.account, p.chainId), keccak256(abiEncode(['bytes32', 'bytes32'], [TYPEHASH.message, p.hash])));
}

export function cancelDigest(p: { account: Hex; chainId: bigint; id: Hex }): Hex {
  return typedDataDigest(domainSeparator(p.account, p.chainId), keccak256(abiEncode(['bytes32', 'bytes32'], [TYPEHASH.cancel, p.id])));
}

export function recoveryDigest(p: {
  account: Hex;
  chainId: bigint;
  recoverySignerId: Hex;
  newX: bigint;
  newY: bigint;
  deadline: bigint;
}): Hex {
  const structHash = keccak256(
    abiEncode(
      ['bytes32', 'bytes32', 'uint256', 'uint256', 'uint64'],
      [TYPEHASH.startRecovery, p.recoverySignerId, p.newX, p.newY, p.deadline],
    ),
  );
  return typedDataDigest(domainSeparator(p.account, p.chainId), structHash);
}

export function signerIdOf(x: bigint, y: bigint): Hex {
  return bytesToHex(keccak256(abiEncode(['uint256', 'uint256'], [x, y])));
}

// ── ECDSA signature handling ──────────────────────────────────────────────────────

/** Strict DER parse of an ECDSA-Sig-Value (SEQUENCE { INTEGER r, INTEGER s }), as WebAuthn returns it. */
export function parseDerSignature(der: Uint8Array): { r: bigint; s: bigint } {
  const fail = (why: string): never => {
    throw new Error(`bad DER signature: ${why}`);
  };
  if (der.length < 8 || der.length > 72) fail('length');
  if (der[0] !== 0x30) fail('not a SEQUENCE');
  if (der[1] !== der.length - 2 || der[1] >= 0x80) fail('sequence length');
  let i = 2;
  const readInt = (): bigint => {
    if (der[i] !== 0x02) fail('not an INTEGER');
    const len = der[i + 1];
    if (len === 0 || len > 33 || i + 2 + len > der.length) fail('integer length');
    const body = der.subarray(i + 2, i + 2 + len);
    if (body[0] & 0x80) fail('negative integer');
    if (len > 1 && body[0] === 0x00 && !(body[1] & 0x80)) fail('non-minimal integer');
    i += 2 + len;
    return bytesToBig(body);
  };
  const r = readInt();
  const s = readInt();
  if (i !== der.length) fail('trailing bytes');
  if (r < 1n || r >= P256_N || s < 1n || s >= P256_N) fail('r or s out of range');
  return { r, s };
}

/** (r, s) and (r, n - s) are both valid; the contract accepts only s <= n/2. */
export function normaliseS(s: bigint): bigint {
  return s > P256_HALF_N ? P256_N - s : s;
}

// ── (ii) browser assertion -> contract Assertion ──────────────────────────────────

export interface Assertion {
  signerId: Hex;
  r: Hex;
  s: Hex;
  challengeIndex: bigint;
  typeIndex: bigint;
  originIndex: bigint;
  authenticatorData: Hex;
  clientDataJSON: string;
}

/** The response fields of a browser `PublicKeyCredential` from navigator.credentials.get(). */
export interface AssertionResponse {
  authenticatorData: ArrayBuffer | Uint8Array;
  clientDataJSON: ArrayBuffer | Uint8Array;
  signature: ArrayBuffer | Uint8Array;
}

export interface Expected {
  challenge: Hex; // the digest the client computed itself
  rpId: string; // "localhost" for the local wallet
  origin: string; // "http://localhost:5175"
}

export class AssertionCheckError extends Error {
  readonly reason: string;
  constructor(reason: string, detail: string) {
    super(`${reason}: ${detail}`);
    this.reason = reason;
  }
}

function indexOfBytes(hay: Uint8Array, needle: string): number {
  return Buffer.from(hay).indexOf(Buffer.from(needle, 'utf8'));
}

/**
 * Checks a browser assertion against every rule the contract applies, then returns the contract's Assertion.
 * Indices are byte offsets into clientDataJSON (what the contract uses), not UTF-16 string offsets.
 */
export function toContractAssertion(resp: AssertionResponse, signerId: Hex, expect: Expected): Assertion {
  const ad = toBytes(resp.authenticatorData);
  const cdBytes = toBytes(resp.clientDataJSON);
  if (ad.length < 37) throw new AssertionCheckError('authenticator-data', `length ${ad.length} < 37`);
  if (bytesToHex(ad.subarray(0, 32)) !== bytesToHex(sha256(expect.rpId))) {
    throw new AssertionCheckError('rp-id-hash', `authenticatorData is not for rpId "${expect.rpId}"`);
  }
  const flags = ad[32];
  if (!(flags & FLAG_UP)) throw new AssertionCheckError('user-present', 'UP flag not set');
  if (!(flags & FLAG_UV)) throw new AssertionCheckError('user-verified', 'UV flag not set (user verification is required)');
  if (flags & FLAG_BS && !(flags & FLAG_BE)) throw new AssertionCheckError('backup-flags', 'BS set without BE');

  let clientDataJSON: string;
  try {
    // ignoreBOM: true keeps a leading BOM in the string, so that re-encoding gives back the signed bytes.
    clientDataJSON = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(cdBytes);
  } catch {
    throw new AssertionCheckError('client-data', 'clientDataJSON is not valid UTF-8');
  }
  if (bytesToHex(utf8(clientDataJSON)) !== bytesToHex(cdBytes)) {
    throw new AssertionCheckError('client-data', 'clientDataJSON does not re-encode to the signed bytes');
  }
  const typeIndex = indexOfBytes(cdBytes, '"type":"webauthn.get"');
  if (typeIndex < 0) throw new AssertionCheckError('type', 'clientDataJSON type is not webauthn.get');
  const challengeField = `"challenge":"${base64url(hexToBytes(expect.challenge))}"`;
  const challengeIndex = indexOfBytes(cdBytes, challengeField);
  if (challengeIndex < 0) throw new AssertionCheckError('challenge', 'clientDataJSON does not carry the expected challenge');
  const originIndex = indexOfBytes(cdBytes, `"origin":${JSON.stringify(expect.origin)}`);
  if (originIndex < 0) throw new AssertionCheckError('origin', `assertion was not made on ${expect.origin}`);

  const { r, s } = parseDerSignature(toBytes(resp.signature));
  return {
    signerId,
    r: bytesToHex(bigToBytes32(r)),
    s: bytesToHex(bigToBytes32(normaliseS(s))),
    challengeIndex: BigInt(challengeIndex),
    typeIndex: BigInt(typeIndex),
    originIndex: BigInt(originIndex),
    authenticatorData: bytesToHex(ad),
    clientDataJSON,
  };
}

/** Independent off-chain check of an Assertion's P-256 signature (node:crypto), for diagnostics and tests. */
export function verifyAssertionSignature(a: Assertion, x: bigint, y: bigint): boolean {
  const message = concat(hexToBytes(a.authenticatorData), sha256(utf8(a.clientDataJSON)));
  return nodeVerify('sha256', message, { key: publicKeyObject(x, y), dsaEncoding: 'ieee-p1363' }, concat(hexToBytes(a.r), hexToBytes(a.s)));
}

export function sortAssertions(as: Assertion[]): Assertion[] {
  return [...as].sort((a, b) => (BigInt(a.signerId) < BigInt(b.signerId) ? -1 : BigInt(a.signerId) > BigInt(b.signerId) ? 1 : 0));
}

const assertionTuple = (a: Assertion): unknown[] => [
  a.signerId,
  a.r,
  a.s,
  a.challengeIndex,
  a.typeIndex,
  a.originIndex,
  a.authenticatorData,
  a.clientDataJSON,
];

// ── calldata ──────────────────────────────────────────────────────────────────────

export function encodeExecute(calls: Call[], nonce: bigint, deadline: bigint, assertions: Assertion[]): Hex {
  return encodeCall(`execute(${CALL_TUPLE}[],uint256,uint64,${ASSERTION_TUPLE}[])`, [
    calls.map((c) => [c.target, c.value, c.data]),
    nonce,
    deadline,
    sortAssertions(assertions).map(assertionTuple),
  ]);
}

/** The `signature` argument of isValidSignature (and the owner signature the vault passes through). */
export function encodeErc1271Signature(assertions: Assertion[]): Hex {
  return bytesToHex(abiEncode([`${ASSERTION_TUPLE}[]`], [sortAssertions(assertions).map(assertionTuple)]));
}

export function encodeIsValidSignature(hash: Hex, signature: Hex): Hex {
  return encodeCall('isValidSignature(bytes32,bytes)', [hash, signature]);
}

export function encodeCancel(id: Hex, assertion: Assertion): Hex {
  return encodeCall(`cancel(bytes32,${ASSERTION_TUPLE})`, [id, assertionTuple(assertion)]);
}

export function encodeStartRecovery(recoverySignerId: Hex, newX: bigint, newY: bigint, deadline: bigint, r: Hex, s: Hex): Hex {
  return encodeCall('startRecovery(bytes32,uint256,uint256,uint64,bytes32,bytes32)', [recoverySignerId, newX, newY, deadline, r, s]);
}

/** R13: a recovery while a guardian is set: the recovery key's signature and the guardian's assertion over the same digest. */
export function encodeStartCosignedRecovery(recoverySignerId: Hex, newX: bigint, newY: bigint, deadline: bigint, r: Hex, s: Hex, cosign: Assertion): Hex {
  return encodeCall(`startCosignedRecovery(bytes32,uint256,uint256,uint64,bytes32,bytes32,${ASSERTION_TUPLE})`, [recoverySignerId, newX, newY, deadline, r, s, assertionTuple(cosign)]);
}
/** R13: self-call data that schedules a guardian (x, y), or its removal (0, 0), behind the delay; needs adminThreshold. */
export const encodeSetGuardian = (x: bigint, y: bigint): Hex => encodeCall('setGuardian(uint256,uint256)', [x, y]);
/** R13: self-call data that turns the time-lock on (at once) or schedules turning it off (behind the delay). */
export const encodeSetTimeLock = (on: boolean): Hex => encodeCall('setTimeLock(bool)', [on]);

export const encodeFinishRecovery = (id: Hex): Hex => encodeCall('finishRecovery(bytes32)', [id]);
export const encodeApplyChange = (id: Hex): Hex => encodeCall('applyChange(bytes32)', [id]);
export const encodeAddSigner = (x: bigint, y: bigint, role: RoleValue): Hex => encodeCall('addSigner(uint256,uint256,uint8)', [x, y, role]);
export const encodeRemoveSigners = (ids: Hex[]): Hex =>
  encodeCall('removeSigners(bytes32[])', [[...ids].sort((a, b) => (BigInt(a) < BigInt(b) ? -1 : 1))]);
export const encodeSetThresholds = (t: bigint, a: bigint): Hex => encodeCall('setThresholds(uint256,uint256)', [t, a]);
export const encodeSetDelays = (d: bigint, rd: bigint): Hex => encodeCall('setDelays(uint64,uint64)', [d, rd]);
/** Self-call data (target = the account) that schedules `calls` on the delayed path; needs adminThreshold. */
export const encodeScheduleCalls = (calls: Call[]): Hex =>
  encodeCall(`scheduleCalls(${CALL_TUPLE}[])`, [calls.map((c) => [c.target, c.value, c.data])]);
/** Runs a scheduled batch after its delay (anyone may send it); `calls` must be exactly the scheduled ones. */
export const encodeApplyCalls = (changeId: Hex, calls: Call[]): Hex =>
  encodeCall(`applyCalls(bytes32,${CALL_TUPLE}[])`, [changeId, calls.map((c) => [c.target, c.value, c.data])]);

// ── (iv) guarded calls ────────────────────────────────────────────────────────────

/** A call the account refuses on its immediate path; it runs only through scheduleCalls + delay + applyCalls. */
export interface Guard {
  target: Hex;
  selector: Hex; // 4 bytes
  reason: string;
}

export const selectorOf = (signature: string): Hex => bytesToHex(selector(signature));

/**
 * The recommended guarded set for one workspace's vault set (the release's QEDVault, QEDExecution and
 * QEDTreasuryPolicy): every call that takes the vault away or widens who may move its funds or how much.
 * Same entries and reasons as test/helpers/Release.sol and README "Guarded calls".
 */
export function releaseGuards(p: { vault: Hex; execution?: Hex; policy?: Hex }): Guard[] {
  const g: Guard[] = [
    {
      target: p.vault,
      selector: selectorOf('transferOwnership(address)'),
      reason: 'Moves every owner power over the vault, and through vault.owner() over its execution and policy contracts, to another address.',
    },
    {
      target: p.vault,
      selector: selectorOf('setAgent(address)'),
      reason: "The agent is the only key that can redeem the owner's mandates; replacing it changes who can move the vault's funds.",
    },
    {
      target: p.vault,
      selector: selectorOf('setCosigner(address)'),
      reason: "The co-signer certifies every payment independently; replacing it changes who approves the vault's outflows.",
    },
    {
      target: p.vault,
      selector: selectorOf('setDailyCap(uint256)'),
      reason:
        'The daily cap bounds all agent payments across every mandate; raising it lets the agent move more. Guarded by selector, so lowering also waits; pause, bumpEpoch and revokeMandate stay immediate.',
    },
  ];
  if (p.execution) {
    g.push(
      {
        target: p.execution,
        selector: selectorOf('setVenues(address[],uint16[])'),
        reason: "The venue set decides where the agent's orders may trade the vault's funds; adding a venue widens where they can go.",
      },
      {
        target: p.execution,
        selector: selectorOf('setOperator(address)'),
        reason: "The operator is the hot key that may call trade and pay against the vault; replacing it changes who can move the vault's funds.",
      },
    );
  }
  if (p.policy) {
    g.push(
      {
        target: p.policy,
        selector: selectorOf('setPolicy((uint256,uint256,uint256,uint16,uint16,uint64))'),
        reason:
          "The standing conversion policy's limits bound automatic conversions; raising them lets more move. Guarded by selector, so any change waits; revoke() stays immediate.",
      },
      {
        target: p.policy,
        selector: selectorOf('setAgent(address)'),
        reason: "The policy agent is the key allowed to run conversions under the policy; replacing it changes who can move the treasury's funds.",
      },
    );
  }
  return g;
}

/**
 * The recommended protective set for one vault (and its policy contract, if any), R13: calls that only stop things and
 * move no money, which ONE member may make through `protect` whatever the thresholds, even while frozen. Same entries
 * and reasons as test/helpers/Release.sol `ReleaseProtective` and README "Protective calls" (a unit test compares them).
 */
export function releaseProtective(p: { vault: Hex; policy?: Hex }): Guard[] {
  const g: Guard[] = [
    {
      target: p.vault,
      selector: selectorOf('pause()'),
      reason: 'Halts the agent at once: no mandate can be used until the owner resumes; creditors are still paid. Moves no money.',
    },
    {
      target: p.vault,
      selector: selectorOf('bumpEpoch()'),
      reason: 'Invalidates every outstanding mandate and certificate at once. Moves no money.',
    },
    { target: p.vault, selector: selectorOf('revokeMandate(bytes32)'), reason: 'Revokes one mandate at once. Moves no money.' },
  ];
  if (p.policy) g.push({ target: p.policy, selector: selectorOf('revoke()'), reason: 'Ends the standing conversion policy at once. Moves no money.' });
  return g;
}

/**
 * The optional time-locked set for one vault (R13): the owner's own moves of free funds and the vault's emergency
 * settings. They run at once at the account's threshold unless the account's time-lock is on; then `execute` refuses
 * them like guarded calls and they wait the account's delay. Same entries and reasons as test/helpers/Release.sol
 * `ReleaseLockable` (a unit test compares them).
 */
export function releaseLockable(p: { vault: Hex }): Guard[] {
  return [
    {
      target: p.vault,
      selector: selectorOf('withdraw(address,uint256)'),
      reason: "Moves the vault's free funds to any address. Time-locked, a withdrawal waits the account's delay, during which any one member can cancel it.",
    },
    {
      target: p.vault,
      selector: selectorOf('ringFence(address,uint256,uint64,bytes32)'),
      reason: "Sets free funds aside for any creditor, irrevocably by the owner. Time-locked, it waits the account's delay, during which any one member can cancel it.",
    },
    {
      target: p.vault,
      selector: selectorOf('unpause()'),
      reason: "Lets the agent pay again after a pause. Time-locked, resuming waits the account's delay; pausing stays immediate.",
    },
    {
      target: p.vault,
      selector: selectorOf('setGuardian(address)'),
      reason: "Replaces the vault's guardian, the address that may pause it in an emergency. Time-locked, a new one waits the account's delay.",
    },
  ];
}

/** True when `call` would be refused by `execute` under `guards` (the client can route it to scheduleCalls). */
export function isGuardedCall(call: Call, guards: Guard[]): boolean {
  if (hexToBytes(call.data).length < 4) return false;
  const sel = call.data.slice(0, 10).toLowerCase();
  return guards.some((g) => g.target.toLowerCase() === call.target.toLowerCase() && g.selector.toLowerCase() === sel);
}

export interface SignerInit {
  x: bigint;
  y: bigint;
  role: RoleValue;
}

/** Constructor arguments, to append to the creation bytecode. */
export function encodeConstructorArgs(p: {
  rpId: string;
  origin: string;
  signers: SignerInit[];
  threshold: bigint;
  adminThreshold: bigint;
  delay: bigint;
  recoveryDelay: bigint;
  guards: Guard[];
  /** R13: calls one member may make through `protect` (default none) and the sentinel (default none). */
  protective?: Guard[];
  sentinel?: Hex;
  /** R13: calls `execute` refuses while the time-lock is on (default none), and whether it starts on (default off). */
  lockable?: Guard[];
  timeLocked?: boolean;
}): Hex {
  return bytesToHex(
    abiEncode(
      ['bytes32', 'string', '(uint256,uint256,uint8)[]', 'uint256', 'uint256', 'uint64', 'uint64', '(address,bytes4,string)[]', '(address,bytes4,string)[]', 'address', '(address,bytes4,string)[]', 'bool'],
      [
        sha256(p.rpId),
        p.origin,
        p.signers.map((s) => [s.x, s.y, s.role]),
        p.threshold,
        p.adminThreshold,
        p.delay,
        p.recoveryDelay,
        p.guards.map((g) => [g.target, g.selector, g.reason]),
        (p.protective ?? []).map((g) => [g.target, g.selector, g.reason]),
        p.sentinel ?? '0x0000000000000000000000000000000000000000',
        (p.lockable ?? []).map((g) => [g.target, g.selector, g.reason]),
        p.timeLocked === true,
      ],
    ),
  );
}

// ── keys ──────────────────────────────────────────────────────────────────────────

function b64uToBig(s: string): bigint {
  return bytesToBig(Uint8Array.from(Buffer.from(s, 'base64url')));
}

function bigToB64u(v: bigint): string {
  return Buffer.from(bigToBytes32(v)).toString('base64url');
}

export function publicKeyObject(x: bigint, y: bigint): KeyObject {
  return createPublicKey({ key: { kty: 'EC', crv: 'P-256', x: bigToB64u(x), y: bigToB64u(y) }, format: 'jwk' });
}

function keyFromScalar(d: bigint): { privateKey: KeyObject; x: bigint; y: bigint } {
  if (d < 1n || d >= P256_N) throw new Error('private scalar out of range');
  const ecdh = createECDH('prime256v1');
  ecdh.setPrivateKey(Buffer.from(bigToBytes32(d)));
  const pub = ecdh.getPublicKey(); // 0x04 || x || y
  const x = bytesToBig(pub.subarray(1, 33));
  const y = bytesToBig(pub.subarray(33, 65));
  const privateKey = createPrivateKey({
    key: { kty: 'EC', crv: 'P-256', d: bigToB64u(d), x: bigToB64u(x), y: bigToB64u(y) },
    format: 'jwk',
  });
  return { privateKey, x, y };
}

function coordinates(privateKey: KeyObject): { x: bigint; y: bigint } {
  const jwk = privateKey.export({ format: 'jwk' });
  if (jwk.crv !== 'P-256' || !jwk.x || !jwk.y) throw new Error('not a P-256 key');
  return { x: b64uToBig(jwk.x), y: b64uToBig(jwk.y) };
}

// ── (iii) software authenticator (tests only) ─────────────────────────────────────

export interface GetAssertionOptions {
  challenge: Hex | Uint8Array;
  rpId: string;
  origin: string;
  userPresent?: boolean; // default true
  userVerified?: boolean; // default true
  backupEligible?: boolean; // default true (a synced passkey)
  backupState?: boolean; // default true
  type?: string; // default "webauthn.get"
  crossOrigin?: boolean; // default false
}

/** A software WebAuthn authenticator: produces exactly what a browser hands to the page after get(). */
export class SoftwarePasskey {
  readonly privateKey: KeyObject;
  readonly x: bigint;
  readonly y: bigint;
  signCount = 0;

  constructor(privateKey: KeyObject) {
    this.privateKey = privateKey;
    const c = coordinates(privateKey);
    this.x = c.x;
    this.y = c.y;
  }

  static generate(): SoftwarePasskey {
    return new SoftwarePasskey(generateKeyPairSync('ec', { namedCurve: 'P-256' }).privateKey);
  }

  static fromScalar(d: bigint): SoftwarePasskey {
    return new SoftwarePasskey(keyFromScalar(d).privateKey);
  }

  get signerId(): Hex {
    return signerIdOf(this.x, this.y);
  }

  getAssertion(o: GetAssertionOptions): { authenticatorData: Uint8Array; clientDataJSON: Uint8Array; signature: Uint8Array } {
    const flags =
      (o.userPresent === false ? 0 : FLAG_UP) |
      (o.userVerified === false ? 0 : FLAG_UV) |
      (o.backupEligible === false ? 0 : FLAG_BE) |
      (o.backupState === false ? 0 : FLAG_BS);
    this.signCount += 1;
    const counter = new Uint8Array(4);
    new DataView(counter.buffer).setUint32(0, this.signCount);
    const authenticatorData = concat(sha256(o.rpId), Uint8Array.of(flags), counter);
    // Serialised in the order and form of WebAuthn Level 3, section 5.8.1.1 (CollectedClientData).
    const clientDataJSON = utf8(
      `{"type":${JSON.stringify(o.type ?? 'webauthn.get')},"challenge":${JSON.stringify(base64url(toBytes(o.challenge)))},` +
        `"origin":${JSON.stringify(o.origin)},"crossOrigin":${o.crossOrigin ? 'true' : 'false'}}`,
    );
    // An authenticator signs authenticatorData || SHA-256(clientDataJSON) with ECDSA/SHA-256 and returns DER.
    const signature = new Uint8Array(nodeSign('sha256', concat(authenticatorData, sha256(clientDataJSON)), this.privateKey));
    return { authenticatorData, clientDataJSON, signature };
  }
}

// ── recovery codes ────────────────────────────────────────────────────────────────

const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

/**
 * A new recovery code: 130 random bits as 26 Crockford base-32 characters, grouped 5-5-5-5-6.
 * The Recovery key's public key is on-chain, so the code must resist offline guessing: never shorten it.
 */
export function generateRecoveryCode(): string {
  const bits = BigInt(bytesToHex(randomBytes(17))) >> 6n; // 130 bits
  let chars = '';
  for (let i = 25; i >= 0; i--) chars += CROCKFORD[Number((bits >> BigInt(i * 5)) & 31n)];
  return [0, 5, 10, 15, 20].map((i) => chars.slice(i, i === 20 ? 26 : i + 5)).join('-');
}

function normaliseCode(code: string): string {
  const c = code.toUpperCase().replace(/[\s-]/g, '').replace(/O/g, '0').replace(/[IL]/g, '1');
  if (!/^[0-9A-HJKMNP-TV-Z]{26}$/.test(c)) throw new Error('a recovery code has 26 base-32 characters');
  return c;
}

/** The Recovery signer a code stands for: raw P-256 key from scrypt(code), never a passkey. */
export class RecoveryKey {
  readonly privateKey: KeyObject;
  readonly x: bigint;
  readonly y: bigint;

  constructor(code: string) {
    const material = scryptSync(normaliseCode(code), 'QEDOwnerAccount recovery v1', 48, { N: 1 << 15, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });
    const d = (bytesToBig(material) % (P256_N - 1n)) + 1n;
    const k = keyFromScalar(d);
    this.privateKey = k.privateKey;
    this.x = k.x;
    this.y = k.y;
  }

  get signerId(): Hex {
    return signerIdOf(this.x, this.y);
  }

  /** ECDSA/SHA-256 over the 32 digest bytes (what WebCrypto ECDSA with SHA-256 gives), s normalised. */
  signDigest(digest: Hex): { r: Hex; s: Hex } {
    const sig = nodeSign('sha256', hexToBytes(digest), { key: this.privateKey, dsaEncoding: 'ieee-p1363' });
    const r = bytesToBig(sig.subarray(0, 32));
    const s = normaliseS(bytesToBig(sig.subarray(32, 64)));
    return { r: bytesToHex(bigToBytes32(r)), s: bytesToHex(bigToBytes32(s)) };
  }
}
