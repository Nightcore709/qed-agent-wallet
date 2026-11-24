/** Offline tests of webauthn.ts: hashes, ABI encoding against Foundry's cast, DER, s normalisation, local checks. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { generateKeyPairSync, sign as nodeSign, verify as nodeVerify } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import * as W from '../webauthn.ts';
import type { Hex } from '../webauthn.ts';

const cast = (...args: string[]): string => execFileSync('cast', args, { encoding: 'utf8' }).trim();
const RP_ID = 'localhost';
const ORIGIN = 'http://localhost:5175';

test('keccak-256 and sha-256 from node:crypto match known vectors', () => {
  assert.equal(W.bytesToHex(W.keccak256('')), '0xc5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470');
  assert.equal(W.bytesToHex(W.keccak256('abc')), '0x4e03657aea45a94fc7d47ba826c8d667c0d1e6e33a64a036ec44f58fa12d6c45');
  assert.equal(W.bytesToHex(W.sha256('localhost')), '0x49960de5880e8c687434170f6476605b8fe4aeb9a28632c7995cf3ba831d9763');
  assert.equal(W.bytesToHex(W.keccak256('hello')), cast('keccak', 'hello'));
});

test('function selectors match cast sig', () => {
  const sig = 'execute((address,uint256,bytes)[],uint256,uint64,(bytes32,bytes32,bytes32,uint256,uint256,uint256,bytes,string)[])';
  assert.equal(W.bytesToHex(W.selector(sig)), cast('sig', sig));
  assert.equal(W.encodeCall('acceptOwnership()'), cast('calldata', 'acceptOwnership()'));
});

test('ABI encoding of execute calldata matches cast calldata', () => {
  const sig = 'execute((address,uint256,bytes)[],uint256,uint64,(bytes32,bytes32,bytes32,uint256,uint256,uint256,bytes,string)[])';
  const a = '0x1111111111111111111111111111111111111111';
  const b = '0x2222222222222222222222222222222222222222';
  const h1 = `0x${'ab'.repeat(32)}`;
  const h2 = `0x${'cd'.repeat(32)}`;
  const h3 = `0x${'ef'.repeat(32)}`;
  const ours = W.encodeCall(sig, [
    [
      [a, 5n, '0x1234'],
      [b, 0n, '0x'],
    ],
    7n,
    1_800_000_000n,
    [[h1, h2, h3, 23n, 1n, 81n, '0x' + '05'.repeat(37), 'hello world']],
  ]);
  const theirs = cast(
    'calldata',
    sig,
    `[(${a},5,0x1234),(${b},0,0x)]`,
    '7',
    '1800000000',
    `[(${h1},${h2},${h3},23,1,81,0x${'05'.repeat(37)},"hello world")]`,
  );
  assert.equal(ours, theirs);
});

test('ABI encoding of constructor arguments and of the vault Mandate matches cast abi-encode', () => {
  const target = '0x4444444444444444444444444444444444444444' as Hex;
  const ours = W.encodeConstructorArgs({
    rpId: RP_ID,
    origin: ORIGIN,
    signers: [
      { x: 1n, y: 2n, role: W.Role.Member },
      { x: 3n, y: 4n, role: W.Role.Recovery },
    ],
    threshold: 1n,
    adminThreshold: 2n,
    delay: 86400n,
    recoveryDelay: 259200n,
    guards: [{ target, selector: '0x12345678', reason: 'a reason' }],
    protective: [{ target, selector: '0x8456cb59', reason: 'stops' }],
    sentinel: '0x5555555555555555555555555555555555555555',
    lockable: [{ target, selector: '0x3f4ba83a', reason: 'resumes' }],
    timeLocked: true,
  });
  const theirs = cast(
    'abi-encode',
    'f(bytes32,string,(uint256,uint256,uint8)[],uint256,uint256,uint64,uint64,(address,bytes4,string)[],(address,bytes4,string)[],address,(address,bytes4,string)[],bool)',
    W.bytesToHex(W.sha256(RP_ID)),
    ORIGIN,
    '[(1,2,1),(3,4,2)]',
    '1',
    '2',
    '86400',
    '259200',
    `[(${target},0x12345678,"a reason")]`,
    `[(${target},0x8456cb59,"stops")]`,
    '0x5555555555555555555555555555555555555555',
    `[(${target},0x3f4ba83a,"resumes")]`,
    'true',
  );
  assert.equal(ours, theirs);
  // R13: the guardian and time-lock self-calls, and a co-signed recovery, against cast calldata
  assert.equal(W.encodeSetGuardian(5n, 6n), cast('calldata', 'setGuardian(uint256,uint256)', '5', '6'));
  assert.equal(W.encodeSetTimeLock(false), cast('calldata', 'setTimeLock(bool)', 'false'));
  const h = `0x${'ab'.repeat(32)}` as Hex;
  const cosign = { signerId: h, r: h, s: h, challengeIndex: 23n, typeIndex: 1n, originIndex: 81n, authenticatorData: ('0x' + '05'.repeat(37)) as Hex, clientDataJSON: 'hi' };
  assert.equal(
    W.encodeStartCosignedRecovery(h, 1n, 2n, 3n, h, h, cosign as never),
    cast('calldata', 'startCosignedRecovery(bytes32,uint256,uint256,uint64,bytes32,bytes32,(bytes32,bytes32,bytes32,uint256,uint256,uint256,bytes,string))', h, '1', '2', '3', h, h, `(${h},${h},${h},23,1,81,0x${'05'.repeat(37)},"hi")`),
  );

  const mandateT = '(address,address,address[],uint256,uint256,uint64,uint256,uint64,uint64,uint64,bool,bytes32,bytes32)';
  const p = '0x3333333333333333333333333333333333333333';
  const m = [p, p, [p, p], 1n, 2n, 3n, 4n, 5n, 6n, 7n, true, `0x${'01'.repeat(32)}`, `0x${'02'.repeat(32)}`];
  const ours2 = W.bytesToHex(W.abiEncode([mandateT, 'bytes'], [m, '0xbeef']));
  const theirs2 = cast(
    'abi-encode',
    `f(${mandateT},bytes)`,
    `(${p},${p},[${p},${p}],1,2,3,4,5,6,7,true,0x${'01'.repeat(32)},0x${'02'.repeat(32)})`,
    '0xbeef',
  );
  assert.equal(ours2, theirs2);
});

test('strict DER parsing', () => {
  const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const der = new Uint8Array(nodeSign('sha256', Buffer.from('m'), privateKey));
  const p1363 = new Uint8Array(nodeSign('sha256', Buffer.from('m'), { key: privateKey, dsaEncoding: 'ieee-p1363' }));
  const { r, s } = W.parseDerSignature(der);
  assert.ok(r > 0n && s > 0n);
  // r, s round-trip into a verifying P1363 signature
  const pub = W.publicKeyObject(...(() => {
    const jwk = privateKey.export({ format: 'jwk' });
    return [BigInt('0x' + Buffer.from(jwk.x!, 'base64url').toString('hex')), BigInt('0x' + Buffer.from(jwk.y!, 'base64url').toString('hex'))] as [bigint, bigint];
  })());
  assert.ok(nodeVerify('sha256', Buffer.from('m'), { key: pub, dsaEncoding: 'ieee-p1363' }, W.concat(W.bigToBytes32(r), W.bigToBytes32(s))));
  assert.equal(p1363.length, 64);

  const bad = (bytes: number[], why: RegExp) => assert.throws(() => W.parseDerSignature(Uint8Array.from(bytes)), why);
  bad([0x31, 0x06, 0x02, 0x01, 0x01, 0x02, 0x01, 0x01], /SEQUENCE/);
  bad([0x30, 0x07, 0x02, 0x01, 0x01, 0x02, 0x01, 0x01], /sequence length/);
  bad([0x30, 0x06, 0x02, 0x01, 0x81, 0x02, 0x01, 0x01], /negative/);
  bad([0x30, 0x07, 0x02, 0x02, 0x00, 0x01, 0x02, 0x01, 0x01], /non-minimal/);
  bad([0x30, 0x06, 0x02, 0x01, 0x00, 0x02, 0x01, 0x01], /range/);
  bad([0x30, 0x08, 0x02, 0x01, 0x01, 0x02, 0x01, 0x01, 0x00, 0x00], /trailing|sequence length/);
  bad([0x30, 0x06, 0x03, 0x01, 0x01, 0x02, 0x01, 0x01], /INTEGER/);
});

test('s normalisation: about half of real DER signatures are high-s; normalised ones stay valid', () => {
  const pk = W.SoftwarePasskey.generate();
  let high = 0;
  for (let i = 0; i < 200; i++) {
    const challenge = W.bytesToHex(W.keccak256(`c${i}`));
    const resp = pk.getAssertion({ challenge, rpId: RP_ID, origin: ORIGIN });
    if (W.parseDerSignature(resp.signature).s > W.P256_HALF_N) high++;
    const a = W.toContractAssertion(resp, pk.signerId, { challenge, rpId: RP_ID, origin: ORIGIN });
    assert.ok(BigInt(a.s) <= W.P256_HALF_N);
    assert.ok(W.verifyAssertionSignature(a, pk.x, pk.y));
  }
  assert.ok(high > 50 && high < 150, `high-s count ${high} of 200`);
  assert.equal(W.normaliseS(W.P256_N - 5n), 5n);
  assert.equal(W.normaliseS(5n), 5n);
});

test('toContractAssertion enforces every on-chain rule before anything is sent', () => {
  const pk = W.SoftwarePasskey.generate();
  const challenge = W.bytesToHex(W.keccak256('terms'));
  const ok = { challenge, rpId: RP_ID, origin: ORIGIN };
  const a = W.toContractAssertion(pk.getAssertion({ challenge, rpId: RP_ID, origin: ORIGIN }), pk.signerId, ok);
  assert.equal(a.typeIndex, 1n);
  assert.equal(a.challengeIndex, 23n);
  assert.equal(a.originIndex, 81n);
  const reason = (fn: () => unknown) => {
    try {
      fn();
    } catch (e) {
      return (e as W.AssertionCheckError).reason;
    }
    return 'accepted';
  };
  assert.equal(reason(() => W.toContractAssertion(pk.getAssertion({ challenge, rpId: 'evil.example', origin: ORIGIN }), pk.signerId, ok)), 'rp-id-hash');
  assert.equal(reason(() => W.toContractAssertion(pk.getAssertion({ challenge, rpId: RP_ID, origin: ORIGIN, userVerified: false }), pk.signerId, ok)), 'user-verified');
  assert.equal(reason(() => W.toContractAssertion(pk.getAssertion({ challenge, rpId: RP_ID, origin: ORIGIN, userPresent: false }), pk.signerId, ok)), 'user-present');
  assert.equal(reason(() => W.toContractAssertion(pk.getAssertion({ challenge, rpId: RP_ID, origin: ORIGIN, backupEligible: false }), pk.signerId, ok)), 'backup-flags');
  assert.equal(reason(() => W.toContractAssertion(pk.getAssertion({ challenge, rpId: RP_ID, origin: ORIGIN, type: 'webauthn.create' }), pk.signerId, ok)), 'type');
  assert.equal(reason(() => W.toContractAssertion(pk.getAssertion({ challenge, rpId: RP_ID, origin: 'http://localhost:8080' }), pk.signerId, ok)), 'origin');
  assert.equal(reason(() => W.toContractAssertion(pk.getAssertion({ challenge, rpId: RP_ID, origin: 'http://localhost:51750' }), pk.signerId, ok)), 'origin');
  const other = W.bytesToHex(W.keccak256('other terms'));
  assert.equal(reason(() => W.toContractAssertion(pk.getAssertion({ challenge: other, rpId: RP_ID, origin: ORIGIN }), pk.signerId, ok)), 'challenge');
});

test('recovery codes: 130 bits, normalised input, deterministic key, raw ECDSA/SHA-256 signature', () => {
  const code = W.generateRecoveryCode();
  assert.match(code, /^[0-9A-HJKMNP-TV-Z]{5}(-[0-9A-HJKMNP-TV-Z]{5}){3}-[0-9A-HJKMNP-TV-Z]{6}$/);
  const k1 = new W.RecoveryKey(code);
  const k2 = new W.RecoveryKey(code.toLowerCase().replace(/-/g, ' '));
  assert.equal(k1.signerId, k2.signerId);
  assert.notEqual(new W.RecoveryKey(W.generateRecoveryCode()).signerId, k1.signerId);
  assert.throws(() => new W.RecoveryKey('ABCD-EFGH'), /26 base-32/);
  const digest = W.bytesToHex(W.keccak256('recovery digest'));
  const { r, s } = k1.signDigest(digest);
  assert.ok(BigInt(s) <= W.P256_HALF_N);
  assert.ok(nodeVerify('sha256', W.hexToBytes(digest), { key: W.publicKeyObject(k1.x, k1.y), dsaEncoding: 'ieee-p1363' }, W.concat(W.hexToBytes(r), W.hexToBytes(s))));
});

test('EIP-712 digests agree with viem hashTypedData (independent implementation, test-only)', async (t) => {
  let viem: typeof import('viem');
  try {
    viem = await import('viem');
  } catch {
    t.skip('viem not resolvable from this directory');
    return;
  }
  const account = '0x5FbDB2315678afecb367f032d93F642f64180aa3' as Hex;
  const domain = { name: 'QEDOwnerAccount', version: '1', chainId: 31337, verifyingContract: account } as const;
  const calls = [
    { target: '0x1111111111111111111111111111111111111111' as Hex, value: 5n, data: '0x1234' as Hex },
    { target: '0x2222222222222222222222222222222222222222' as Hex, value: 0n, data: '0x' as Hex },
  ];
  const viemExec = viem.hashTypedData({
    domain,
    primaryType: 'Execute',
    types: {
      Execute: [
        { name: 'calls', type: 'Call[]' },
        { name: 'nonce', type: 'uint256' },
        { name: 'deadline', type: 'uint64' },
      ],
      Call: [
        { name: 'target', type: 'address' },
        { name: 'value', type: 'uint256' },
        { name: 'data', type: 'bytes' },
      ],
    },
    message: { calls, nonce: 9n, deadline: 1234n },
  });
  assert.equal(W.executeDigest({ account, chainId: 31337n, calls, nonce: 9n, deadline: 1234n }), viemExec);

  const hash = W.bytesToHex(W.keccak256('mandate'));
  const viemMsg = viem.hashTypedData({
    domain,
    primaryType: 'QEDOwnerMessage',
    types: { QEDOwnerMessage: [{ name: 'hash', type: 'bytes32' }] },
    message: { hash },
  });
  assert.equal(W.replaySafeHash({ account, chainId: 31337n, hash }), viemMsg);

  const viemCancel = viem.hashTypedData({
    domain,
    primaryType: 'Cancel',
    types: { Cancel: [{ name: 'id', type: 'bytes32' }] },
    message: { id: hash },
  });
  assert.equal(W.cancelDigest({ account, chainId: 31337n, id: hash }), viemCancel);

  const viemRec = viem.hashTypedData({
    domain,
    primaryType: 'StartRecovery',
    types: {
      StartRecovery: [
        { name: 'recoverySignerId', type: 'bytes32' },
        { name: 'newX', type: 'uint256' },
        { name: 'newY', type: 'uint256' },
        { name: 'deadline', type: 'uint64' },
      ],
    },
    message: { recoverySignerId: hash, newX: 3n, newY: 4n, deadline: 99n },
  });
  assert.equal(W.recoveryDigest({ account, chainId: 31337n, recoverySignerId: hash, newX: 3n, newY: 4n, deadline: 99n }), viemRec);
});

test('release guard list: selectors match cast sig, reasons match the Solidity helper word for word', () => {
  const v = '0x1111111111111111111111111111111111111111' as Hex;
  const e = '0x2222222222222222222222222222222222222222' as Hex;
  const p = '0x3333333333333333333333333333333333333333' as Hex;
  const g = W.releaseGuards({ vault: v, execution: e, policy: p });
  const sigs = [
    'transferOwnership(address)',
    'setAgent(address)',
    'setCosigner(address)',
    'setDailyCap(uint256)',
    'setVenues(address[],uint16[])',
    'setOperator(address)',
    'setPolicy((uint256,uint256,uint256,uint16,uint16,uint64))',
    'setAgent(address)',
  ];
  assert.equal(g.length, 8);
  g.forEach((entry, i) => assert.equal(entry.selector, cast('sig', sigs[i]), sigs[i]));
  assert.deepEqual(g.map((x) => x.target), [v, v, v, v, e, e, p, p]);
  const sol = readFileSync(join(import.meta.dirname, '..', 'test', 'helpers', 'Release.sol'), 'utf8');
  const [guardsSol, rest] = sol.split('library ReleaseProtective');
  const [protectiveSol, lockableSol] = rest!.split('library ReleaseLockable');
  const solReasons = [...guardsSol!.matchAll(/^\s*"([^"]+)"\s*$/gm)].map((m) => m[1]);
  assert.deepEqual(g.map((x) => x.reason), solReasons);
  // R13: the protective list, word for word and selector for selector, as the Solidity helper states it
  const pr = W.releaseProtective({ vault: v, policy: p });
  assert.deepEqual(pr.map((x) => x.reason), [...protectiveSol!.matchAll(/"([^"]+)"/g)].map((m) => m[1]));
  assert.deepEqual(pr.map((x) => x.selector), ['pause()', 'bumpEpoch()', 'revokeMandate(bytes32)', 'revoke()'].map((s) => cast('sig', s)));
  assert.deepEqual(pr.map((x) => x.target), [v, v, v, p]);
  assert.equal(W.releaseProtective({ vault: v }).length, 3);
  assert.ok(pr.every((x) => !g.some((y) => y.target === x.target && y.selector === x.selector)), 'never also guarded');
  assert.equal(W.releaseGuards({ vault: v }).length, 4);
  // R13: the optional time-locked list, word for word and selector for selector; never also guarded or protective
  const lk = W.releaseLockable({ vault: v });
  assert.deepEqual(lk.map((x) => x.reason), [...lockableSol!.matchAll(/"([^"]+)"/g)].map((m) => m[1]));
  assert.deepEqual(lk.map((x) => x.selector), ['withdraw(address,uint256)', 'ringFence(address,uint256,uint64,bytes32)', 'unpause()', 'setGuardian(address)'].map((s) => cast('sig', s)));
  assert.ok(lk.every((x) => x.target === v && !g.some((y) => y.selector === x.selector && y.target === x.target) && !pr.some((y) => y.selector === x.selector && y.target === x.target)));
  assert.ok(W.isGuardedCall({ target: v, value: 0n, data: W.encodeCall('setAgent(address)', [e]) }, g));
  assert.ok(!W.isGuardedCall({ target: v, value: 0n, data: W.encodeCall('pause()') }, g));
  assert.ok(!W.isGuardedCall({ target: e, value: 0n, data: W.encodeCall('setDailyCap(uint256)', [1n]) }, g));
});
