/**
 * Integration on real Anvil chains (127.0.0.1, ephemeral, stopped when this file ends):
 *   chain A  osaka, 31337: the release's vault set (QEDVault, QEDExecution, QEDTreasuryPolicy, TestUSD; recorded
 *            release bytecode) with an EOA owner; ownership moves to a QEDOwnerAccount (with the recommended guard
 *            list) accepted through execute with a software-passkey assertion; then
 *            (a) the old EOA can no longer call any owner function, (b) a mandate signed through ERC-1271 pays,
 *            (c) a mandate signature made for another account is refused; guarded calls only on the delayed path;
 *            plus origin, cancel and recovery.
 *   chain B  osaka, 31338: same account bytecode and arguments at the same address; chain-A signatures refused.
 *   chain C  prague (no P-256 precompile): the account cannot be deployed.
 * Every challenge is computed by webauthn.ts and compared with the contract's own view.
 */
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import * as W from '../webauthn.ts';
import type { Hex } from '../webauthn.ts';
import * as H from './helpers.ts';

const RP_ID = 'localhost';
const ORIGIN = 'http://localhost:5175';
const DAY = 86_400n;
const DELAY = DAY;
const RECOVERY_DELAY = 3n * DAY;

const MANDATE_T = '(address,address,address[],uint256,uint256,uint64,uint256,uint64,uint64,uint64,bool,bytes32,bytes32)';
const CERT_T = '(bytes32,address,uint256,uint64,bytes32,bytes32,bytes32,uint64,uint64,uint64)';
const MANDATE_TYPEHASH = W.keccak256(
  'Mandate(address vault,address agent,address[] payees,uint256 maxPerPayment,uint256 maxPerPeriod,uint64 period,uint256 maxTotal,uint64 validFrom,uint64 validUntil,uint64 epoch,bool requireCosign,bytes32 purpose,bytes32 salt)',
);

const evidence: Record<string, unknown> = { startedAt: new Date().toISOString(), node: process.version, gasUsed: {} };
const gas = evidence.gasUsed as Record<string, number>;
const record = (name: string, r: H.Receipt) => {
  gas[name] = Number(BigInt(r.gasUsed));
};

const alice = W.SoftwarePasskey.generate();
const recoveryCode = W.generateRecoveryCode();
const recKey = new W.RecoveryKey(recoveryCode);
let guards: W.Guard[] = [];
let accountArgs: Hex;
const accountCode = H.artifact('QEDOwnerAccount.sol', 'QEDOwnerAccount');

interface Ctx {
  url: string;
  chainId: bigint;
  deployer: Hex;
  eoaOwner: Hex;
  agent: Hex;
  cosigner: Hex;
  guardian: Hex;
  relayer: Hex;
  payee: Hex;
  accountDeployer: Hex;
  token: Hex;
  vault: Hex;
  execution: Hex;
  reserveToken: Hex;
  reserve: Hex;
  policy: Hex;
  account: Hex;
}

/** Signs `calls` with the passkeys through the full browser-shaped path; returns the execute calldata. */
async function signedExecute(c: Ctx, account: Hex, passkeys: W.SoftwarePasskey[], calls: W.Call[], origin = ORIGIN): Promise<Hex> {
  const nonce = H.word(await H.view(c.url, account, 'nonce()'));
  const deadline = (await H.now(c.url)) + 600n;
  const challenge = W.executeDigest({ account, chainId: c.chainId, calls, nonce, deadline });
  const assertions = passkeys.map((pk) =>
    W.toContractAssertion(pk.getAssertion({ challenge, rpId: RP_ID, origin }), pk.signerId, { challenge, rpId: RP_ID, origin }),
  );
  return W.encodeExecute(calls, nonce, deadline, assertions);
}

/** Signs `calls` with the passkeys through the full browser-shaped path and relays the execute. */
async function execute(
  c: Ctx,
  account: Hex,
  passkeys: W.SoftwarePasskey[],
  calls: W.Call[],
  o: { origin?: string; gas?: bigint } = {},
): Promise<{ receipt: H.Receipt; data: Hex }> {
  const nonce = H.word(await H.view(c.url, account, 'nonce()'));
  const deadline = (await H.now(c.url)) + 600n;
  const challenge = W.executeDigest({ account, chainId: c.chainId, calls, nonce, deadline });
  const onChain = await H.view(c.url, account, 'executeDigest((address,uint256,bytes)[],uint256,uint64)', [
    calls.map((x) => [x.target, x.value, x.data]),
    nonce,
    deadline,
  ]);
  assert.equal(onChain, challenge, 'client-computed execute challenge equals the contract view');
  const origin = o.origin ?? ORIGIN;
  const assertions = passkeys.map((pk) =>
    W.toContractAssertion(pk.getAssertion({ challenge, rpId: RP_ID, origin }), pk.signerId, { challenge, rpId: RP_ID, origin }),
  );
  const data = W.encodeExecute(calls, nonce, deadline, assertions);
  const receipt = await H.send(c.url, { from: c.relayer, to: account, data, gas: o.gas ?? 3_000_000n });
  return { receipt, data };
}

function mandate(c: Ctx, salt: string, validFrom: bigint): unknown[] {
  return [c.vault, c.agent, [c.payee], 100_000_000n, 500_000_000n, DAY, 1_000_000_000n, validFrom, validFrom + 7n * DAY, 0n, true, W.bytesToHex(W.keccak256('pay the approved payee')), W.bytesToHex(W.keccak256(salt))];
}

function mandateHash(m: unknown[]): Hex {
  const payees = m[2] as Hex[];
  return W.bytesToHex(
    W.keccak256(
      W.abiEncode(
        ['bytes32', 'address', 'address', 'bytes32', 'uint256', 'uint256', 'uint64', 'uint256', 'uint64', 'uint64', 'uint64', 'bool', 'bytes32', 'bytes32'],
        [MANDATE_TYPEHASH, m[0], m[1], W.keccak256(W.concat(...payees.map((p) => W.abiEncode(['address'], [p])))), ...m.slice(3)],
      ),
    ),
  );
}

function vaultDomain(c: Ctx): Hex {
  return W.bytesToHex(
    W.keccak256(W.abiEncode(['bytes32', 'bytes32', 'bytes32', 'uint256', 'address'], [W.TYPEHASH.domain, W.keccak256('QEDVault'), W.keccak256('1'), c.chainId, c.vault])),
  );
}

async function certificate(c: Ctx, mHash: Hex, amount: bigint, tag: string): Promise<{ cert: unknown[]; cosig: Hex }> {
  const t = await H.now(c.url);
  const intentId = W.bytesToHex(W.keccak256(`intent ${tag}`));
  const evidenceHash = W.bytesToHex(W.keccak256('decision record'));
  const ref = W.bytesToHex(W.keccak256('invoice'));
  const cert = [mHash, c.payee, amount, 0n, intentId, evidenceHash, ref, t - 60n, t + 3600n, 0n];
  const typed = {
    types: {
      EIP712Domain: [
        { name: 'name', type: 'string' },
        { name: 'version', type: 'string' },
        { name: 'chainId', type: 'uint256' },
        { name: 'verifyingContract', type: 'address' },
      ],
      Certificate: [
        { name: 'mandateHash', type: 'bytes32' },
        { name: 'recipient', type: 'address' },
        { name: 'amount', type: 'uint256' },
        { name: 'dueAt', type: 'uint64' },
        { name: 'intentId', type: 'bytes32' },
        { name: 'evidenceHash', type: 'bytes32' },
        { name: 'ref', type: 'bytes32' },
        { name: 'notBefore', type: 'uint64' },
        { name: 'expiresAt', type: 'uint64' },
        { name: 'epoch', type: 'uint64' },
      ],
    },
    primaryType: 'Certificate',
    domain: { name: 'QEDVault', version: '1', chainId: Number(c.chainId), verifyingContract: c.vault },
    message: {
      mandateHash: mHash,
      recipient: c.payee,
      amount: amount.toString(),
      dueAt: '0',
      intentId,
      evidenceHash,
      ref,
      notBefore: (t - 60n).toString(),
      expiresAt: (t + 3600n).toString(),
      epoch: '0',
    },
  };
  // The co-signer is an Anvil development account (published test key) signing with eth_signTypedData_v4.
  const cosig = (await H.rpc(c.url, 'eth_signTypedData_v4', [c.cosigner, typed])) as Hex;
  return { cert, cosig };
}

const encodeExecutePayment = (m: unknown[], ownerSig: Hex, cert: unknown[], cosig: Hex): Hex =>
  W.encodeCall(`executePayment(${MANDATE_T},bytes,${CERT_T},bytes)`, [m, ownerSig, cert, cosig]);

async function ownerSignature(c: Ctx, signerAccount: Hex, digest: Hex, pk: W.SoftwarePasskey): Promise<Hex> {
  const challenge = W.replaySafeHash({ account: signerAccount, chainId: c.chainId, hash: digest });
  assert.equal(await H.view(c.url, signerAccount, 'replaySafeHash(bytes32)', [digest]), challenge);
  const a = W.toContractAssertion(pk.getAssertion({ challenge, rpId: RP_ID, origin: ORIGIN }), pk.signerId, { challenge, rpId: RP_ID, origin: ORIGIN });
  return W.encodeErc1271Signature([a]);
}

const isValid = async (url: string, account: Hex, hash: Hex, sig: Hex): Promise<Hex> =>
  (await H.call(url, { to: account, data: W.encodeIsValidSignature(hash, sig) })).slice(0, 10) as Hex;

const balanceOf = async (c: Ctx, who: Hex): Promise<bigint> => H.word(await H.view(c.url, c.token, 'balanceOf(address)', [who]));

function topicId(r: H.Receipt, eventSig: string): Hex {
  const t0 = W.bytesToHex(W.keccak256(eventSig));
  const log = r.logs.find((l) => l.topics[0] === t0);
  if (!log) throw new Error(`no ${eventSig} in receipt`);
  return log.topics[1];
}

let chainA: H.Chain;
let chainB: H.Chain | undefined;
let chainC: H.Chain | undefined;
const A = {} as Ctx;
let firstExecuteCalldata: Hex;
let aliceMandateSig: Hex;
let aliceMandateDigest: Hex;

before(async () => {
  chainA = await H.startAnvil({ hardfork: 'osaka', chainId: 31337 });
  A.url = chainA.url;
  A.chainId = 31337n;
  const accts = (await H.rpc(A.url, 'eth_accounts', [])) as Hex[];
  [A.deployer, A.eoaOwner, A.agent, A.cosigner, A.guardian, A.relayer, A.payee] = accts;
  A.accountDeployer = accts[9];
  A.token = (await H.deploy(A.url, A.deployer, H.releaseBytecode('TestUSD'))).address;
  const vaultArgs = W.bytesToHex(
    W.abiEncode(['address', 'address', 'address', 'address', 'address', 'uint256'], [A.token, A.eoaOwner, A.agent, A.cosigner, A.guardian, 1_000_000_000n]),
  );
  const v = await H.deploy(A.url, A.deployer, H.releaseBytecode('QEDVault'), vaultArgs);
  A.vault = v.address;
  record('deploy QEDVault (release bytecode)', v.receipt);
  A.execution = (
    await H.deploy(A.url, A.deployer, H.releaseBytecode('QEDExecution'), W.bytesToHex(W.abiEncode(['address', 'address'], [A.vault, A.agent])))
  ).address;
  A.reserveToken = (await H.deploy(A.url, A.deployer, H.releaseBytecode('TestUSD'))).address;
  A.reserve = (
    await H.deploy(
      A.url,
      A.deployer,
      H.releaseBytecode('QEDVault'),
      W.bytesToHex(
        W.abiEncode(['address', 'address', 'address', 'address', 'address', 'uint256'], [A.reserveToken, A.eoaOwner, A.agent, A.cosigner, A.guardian, 1_000_000_000n]),
      ),
    )
  ).address;
  A.policy = (
    await H.deploy(
      A.url,
      A.deployer,
      H.releaseBytecode('QEDTreasuryPolicy'),
      W.bytesToHex(W.abiEncode(['address', 'address', 'address'], [A.execution, A.reserve, A.agent])),
    )
  ).address;
  // The account last, as accountDeployer's very first transaction: the same address on any fresh chain.
  guards = W.releaseGuards({ vault: A.vault, execution: A.execution, policy: A.policy });
  accountArgs = W.encodeConstructorArgs({
    rpId: RP_ID,
    origin: ORIGIN,
    signers: [
      { x: alice.x, y: alice.y, role: W.Role.Member },
      { x: recKey.x, y: recKey.y, role: W.Role.Recovery },
    ],
    threshold: 1n,
    adminThreshold: 1n,
    delay: DELAY,
    recoveryDelay: RECOVERY_DELAY,
    guards,
  });
  const acct = await H.deploy(A.url, A.accountDeployer, accountCode, accountArgs);
  A.account = acct.address;
  record('deploy QEDOwnerAccount (1 Member, 1 Recovery, 8 guards)', acct.receipt);
  await H.send(A.url, { from: A.deployer, to: A.token, data: W.encodeCall('mint(address,uint256)', [A.deployer, 10_000_000_000n]) });
  await H.send(A.url, { from: A.deployer, to: A.token, data: W.encodeCall('approve(address,uint256)', [A.vault, 10_000_000_000n]) });
  const dep = await H.send(A.url, { from: A.deployer, to: A.vault, data: W.encodeCall('deposit(uint256)', [5_000_000_000n]) });
  assert.equal(dep.status, '0x1');
  evidence.chainA = {
    chainId: 31337,
    hardfork: 'osaka',
    account: A.account,
    vault: A.vault,
    execution: A.execution,
    policy: A.policy,
    token: A.token,
    eoaOwner: A.eoaOwner,
    guards: guards.map((g) => ({ target: g.target, selector: g.selector })),
  };
});

after(async () => {
  await chainA?.stop();
  await chainB?.stop();
  await chainC?.stop();
  evidence.finishedAt = new Date().toISOString();
  mkdirSync(join(H.ROOT, 'evidence'), { recursive: true });
  // QED_EVIDENCE_DIR (relative to chain/accounts): where this build's evidence goes, so earlier builds' files stay as history
  const evidenceDir = join(H.ROOT, process.env.QED_EVIDENCE_DIR ?? 'evidence');
  mkdirSync(evidenceDir, { recursive: true });
  writeFileSync(join(evidenceDir, 'anvil-integration.json'), JSON.stringify(evidence, (_, v) => (typeof v === 'bigint' ? v.toString() : v), 2));
});

describe('chain A (osaka): the release vault owned by a passkey account', () => {
  test('the vault set deployed is the release bytecode, and our build of the vendored sources is identical', () => {
    for (const n of ['QEDVault', 'TestUSD', 'QEDExecution', 'QEDTreasuryPolicy'] as const) {
      assert.equal(H.artifact(`${n}.sol`, n), H.releaseBytecode(n), n);
    }
  });

  test('the guard list is on chain as constructed', async () => {
    for (const g of guards) {
      assert.equal(H.word(await H.view(A.url, A.account, 'isGuarded(address,bytes4)', [g.target, g.selector])), 1n);
    }
    const t0 = W.bytesToHex(W.keccak256('GuardConfigured(address,bytes4,string)'));
    const logs = (await H.rpc(A.url, 'eth_getLogs', [{ address: A.account, fromBlock: '0x0', toBlock: 'latest', topics: [t0] }])) as H.Receipt['logs'];
    assert.equal(logs.length, guards.length);
  });

  test('client challenges equal the contract views', async () => {
    assert.equal(await H.view(A.url, A.account, 'domainSeparator()'), W.domainSeparator(A.account, A.chainId));
    const id = W.bytesToHex(W.keccak256('some id'));
    assert.equal(await H.view(A.url, A.account, 'cancelDigest(bytes32)', [id]), W.cancelDigest({ account: A.account, chainId: A.chainId, id }));
    assert.equal(
      await H.view(A.url, A.account, 'recoveryDigest(bytes32,uint256,uint256,uint64)', [recKey.signerId, 3n, 4n, 99n]),
      W.recoveryDigest({ account: A.account, chainId: A.chainId, recoverySignerId: recKey.signerId, newX: 3n, newY: 4n, deadline: 99n }),
    );
    assert.equal(await H.view(A.url, A.account, 'signerIdOf(uint256,uint256)', [alice.x, alice.y]), alice.signerId);
    assert.equal(H.wordHex(await H.view(A.url, A.vault, 'MANDATE_TYPEHASH()')), W.bytesToHex(MANDATE_TYPEHASH));
    assert.equal(await H.view(A.url, A.vault, 'domainSeparator()'), vaultDomain(A));
  });

  test('ownership moves to the account: transferOwnership by the EOA, acceptOwnership through execute with a passkey', async () => {
    const t = await H.send(A.url, { from: A.eoaOwner, to: A.vault, data: W.encodeCall('transferOwnership(address)', [A.account]) });
    assert.equal(t.status, '0x1');
    assert.equal(H.asAddress(await H.view(A.url, A.vault, 'pendingOwner()')), A.account.toLowerCase());
    // a relayer alone cannot accept for the account
    assert.equal(
      await H.revertData(A.url, { from: A.relayer, to: A.vault, data: W.encodeCall('acceptOwnership()') }),
      H.errorData('NotPendingOwner(address)', ['address'], [A.relayer]),
    );
    const { receipt, data } = await execute(A, A.account, [alice], [{ target: A.vault, value: 0n, data: W.encodeCall('acceptOwnership()') }]);
    firstExecuteCalldata = data;
    assert.equal(receipt.status, '0x1');
    record('execute: vault.acceptOwnership (1 assertion)', receipt);
    assert.equal(H.asAddress(await H.view(A.url, A.vault, 'owner()')), A.account.toLowerCase());
    assert.equal(H.word(await H.view(A.url, A.account, 'nonce()')), 1n);
  });

  test('(a) the old EOA can no longer call any onlyOwner function', async () => {
    const t = await H.now(A.url);
    const ownerCalls: [string, unknown[]][] = [
      ['ringFence(address,uint256,uint64,bytes32)', [A.payee, 1_000_000n, t + DAY, `0x${'00'.repeat(32)}`]],
      ['withdraw(address,uint256)', [A.eoaOwner, 1_000_000n]],
      ['unpause()', []],
      ['bumpEpoch()', []],
      ['revokeMandate(bytes32)', [`0x${'01'.repeat(32)}`]],
      ['setAgent(address)', [A.eoaOwner]],
      ['setCosigner(address)', [A.eoaOwner]],
      ['setGuardian(address)', [A.eoaOwner]],
      ['setDailyCap(uint256)', [2n ** 255n]],
      ['transferOwnership(address)', [A.eoaOwner]],
    ];
    const notOwner = H.errorData('NotOwner(address)', ['address'], [A.eoaOwner]);
    const refused: string[] = [];
    for (const [sig, args] of ownerCalls) {
      assert.equal(await H.revertData(A.url, { from: A.eoaOwner, to: A.vault, data: W.encodeCall(sig, args) }), notOwner, sig);
      refused.push(sig);
    }
    assert.equal(
      await H.revertData(A.url, { from: A.eoaOwner, to: A.vault, data: W.encodeCall('pause()') }),
      H.errorData('NotOwnerOrGuardian(address)', ['address'], [A.eoaOwner]),
    );
    assert.equal(
      await H.revertData(A.url, { from: A.eoaOwner, to: A.vault, data: W.encodeCall('acceptOwnership()') }),
      H.errorData('NotPendingOwner(address)', ['address'], [A.eoaOwner]),
    );
    // and a mined transaction from the EOA fails on chain
    const mined = await H.send(A.url, { from: A.eoaOwner, to: A.vault, data: W.encodeCall('setAgent(address)', [A.eoaOwner]), gas: 200_000n });
    assert.equal(mined.status, '0x0');
    // while the account holds the (unguarded) owner functions through execute
    const { receipt } = await execute(A, A.account, [alice], [{ target: A.vault, value: 0n, data: W.encodeCall('revokeMandate(bytes32)', [W.bytesToHex(W.keccak256('old mandate'))]) }]);
    assert.equal(receipt.status, '0x1');
    record('execute: vault.revokeMandate (1 assertion)', receipt);
    evidence.oldEoaRefused = [...refused, 'pause()', 'acceptOwnership()', `mined setAgent status ${mined.status}`];
  });

  test('(b) a mandate signed through ERC-1271 by the account is accepted by the vault for a payment', async () => {
    const t = await H.now(A.url);
    const m = mandate(A, 'salt-b', t - 60n);
    const digest = W.typedDataDigest(vaultDomain(A), W.hexToBytes(mandateHash(m)));
    const ownerSig = await ownerSignature(A, A.account, digest, alice);
    aliceMandateSig = ownerSig;
    aliceMandateDigest = digest;
    assert.equal(await isValid(A.url, A.account, digest, ownerSig), W.ERC1271_MAGIC);
    const { cert, cosig } = await certificate(A, mandateHash(m), 40_000_000n, 'b');
    const before_ = await balanceOf(A, A.payee);
    const r = await H.send(A.url, { from: A.agent, to: A.vault, data: encodeExecutePayment(m, ownerSig, cert, cosig), gas: 1_000_000n });
    assert.equal(r.status, '0x1');
    record('vault.executePayment with ERC-1271 owner signature (agent pays)', r);
    assert.equal((await balanceOf(A, A.payee)) - before_, 40_000_000n);
    // Estimate checkSignature, not isValidSignature: with too little gas isValidSignature returns 0xffffffff without
    // reverting, so an estimate of it measures the cost of answering "invalid", not of verifying.
    const est = await H.rpc(A.url, 'eth_estimateGas', [{ to: A.account, data: W.encodeCall('checkSignature(bytes32,bytes)', [digest, ownerSig]) }]);
    gas['checkSignature, 1 assertion, as a transaction (estimate; includes 21000 intrinsic and calldata)'] = Number(BigInt(est));
  });

  test('(c) a mandate signature made for another account is refused', async () => {
    const other = await H.deploy(A.url, A.deployer, accountCode, accountArgs); // same passkey, second account
    const t = await H.now(A.url);
    const m = mandate(A, 'salt-c', t - 60n);
    const digest = W.typedDataDigest(vaultDomain(A), W.hexToBytes(mandateHash(m)));
    const sigForOther = await ownerSignature(A, other.address, digest, alice);
    assert.equal(await isValid(A.url, other.address, digest, sigForOther), W.ERC1271_MAGIC, 'valid for the account it was made for');
    assert.equal(await isValid(A.url, A.account, digest, sigForOther), W.ERC1271_INVALID, 'invalid for the vault owner');
    const { cert, cosig } = await certificate(A, mandateHash(m), 40_000_000n, 'c');
    const data = encodeExecutePayment(m, sigForOther, cert, cosig);
    assert.equal(await H.revertData(A.url, { from: A.agent, to: A.vault, data }), H.errorData('BadOwnerSignature()'));
    const mined = await H.send(A.url, { from: A.agent, to: A.vault, data, gas: 1_000_000n });
    assert.equal(mined.status, '0x0');
  });

  test('an assertion made on another local origin is refused on chain', async () => {
    const before_ = H.word(await H.view(A.url, A.account, 'nonce()'));
    const calls = [{ target: A.vault, value: 0n, data: W.encodeCall('revokeMandate(bytes32)', [W.bytesToHex(W.keccak256('x'))]) }];
    // A page on http://localhost:8080 can get assertions for rpId "localhost" too; the contract checks the origin.
    const { receipt, data } = await execute(A, A.account, [alice], calls, { origin: 'http://localhost:8080', gas: 1_000_000n });
    assert.equal(receipt.status, '0x0');
    assert.equal(await H.revertData(A.url, { to: A.account, data }), H.errorData('InvalidAssertion(uint256)', ['uint256'], [0n]));
    assert.equal(H.word(await H.view(A.url, A.account, 'nonce()')), before_);
  });

  test('replaying an executed batch is refused (nonce)', async () => {
    assert.equal(
      await H.revertData(A.url, { to: A.account, data: firstExecuteCalldata }),
      H.errorData('BadNonce(uint256,uint256)', ['uint256', 'uint256'], [0n, H.word(await H.view(A.url, A.account, 'nonce()'))]),
    );
  });

  test('guarded calls: refused on the immediate path; the delayed path runs one after the delay; one is cancelled', async () => {
    const someone = A.payee;
    const policyT = '(uint256,uint256,uint256,uint16,uint16,uint64)';
    const t = await H.now(A.url);
    const tries: W.Call[] = [
      { target: A.vault, value: 0n, data: W.encodeCall('transferOwnership(address)', [someone]) },
      { target: A.vault, value: 0n, data: W.encodeCall('setAgent(address)', [someone]) },
      { target: A.vault, value: 0n, data: W.encodeCall('setCosigner(address)', [someone]) },
      { target: A.vault, value: 0n, data: W.encodeCall('setDailyCap(uint256)', [2n ** 255n]) },
      { target: A.execution, value: 0n, data: W.encodeCall('setVenues(address[],uint16[])', [[], []]) },
      { target: A.execution, value: 0n, data: W.encodeCall('setOperator(address)', [someone]) },
      { target: A.policy, value: 0n, data: W.encodeCall(`setPolicy(${policyT})`, [[100_000_000n, 1_000_000n, 50_000_000n, 100, 100, t + 30n * DAY]]) },
      { target: A.policy, value: 0n, data: W.encodeCall('setAgent(address)', [someone]) },
    ];
    assert.equal(tries.length, guards.length);
    for (const call of tries) {
      assert.ok(W.isGuardedCall(call, guards));
      const data = await signedExecute(A, A.account, [alice], [call]);
      assert.equal(
        await H.revertData(A.url, { to: A.account, data }),
        H.errorData('GuardedCall(uint256,address,bytes4)', ['uint256', 'address', 'bytes4'], [0n, call.target, call.data.slice(0, 10)]),
      );
    }
    // pause stays immediate
    const pause = await execute(A, A.account, [alice], [{ target: A.vault, value: 0n, data: W.encodeCall('pause()') }]);
    assert.equal(pause.receipt.status, '0x1');
    assert.equal(H.word(await H.view(A.url, A.vault, 'paused()')), 1n);
    await execute(A, A.account, [alice], [{ target: A.vault, value: 0n, data: W.encodeCall('unpause()') }]);

    // the delayed path: schedule (adminThreshold, here 1), wait `delay`, anyone applies
    const raise: W.Call[] = [{ target: A.vault, value: 0n, data: W.encodeCall('setDailyCap(uint256)', [4_000_000_000n]) }];
    const sch = await execute(A, A.account, [alice], [{ target: A.account, value: 0n, data: W.encodeScheduleCalls(raise) }]);
    assert.equal(sch.receipt.status, '0x1');
    record('execute: scheduleCalls (1 guarded call)', sch.receipt);
    const id = topicId(sch.receipt, 'ChangeScheduled(bytes32,uint8,uint64,uint256,uint256,bytes32[])');
    assert.equal(
      await H.view(A.url, A.account, 'callsHash((address,uint256,bytes)[])', [raise.map((x) => [x.target, x.value, x.data])]),
      W.callsHash(raise),
    );
    const early = await H.revertData(A.url, { to: A.account, data: W.encodeApplyCalls(id, raise) });
    assert.equal(early.slice(0, 10), H.errorData('NotReady(bytes32,uint64)', ['bytes32', 'uint64'], [id, 0n]).slice(0, 10));
    await H.increaseTime(A.url, DELAY);
    const applied = await H.send(A.url, { from: A.payee, to: A.account, data: W.encodeApplyCalls(id, raise) });
    assert.equal(applied.status, '0x1');
    record('applyCalls (1 guarded call)', applied);
    assert.equal(H.word(await H.view(A.url, A.vault, 'dailyCap()')), 4_000_000_000n);

    // a scheduled guarded call cancelled by one Member assertion
    const take: W.Call[] = [{ target: A.vault, value: 0n, data: W.encodeCall('setAgent(address)', [someone]) }];
    const sch2 = await execute(A, A.account, [alice], [{ target: A.account, value: 0n, data: W.encodeScheduleCalls(take) }]);
    const id2 = topicId(sch2.receipt, 'ChangeScheduled(bytes32,uint8,uint64,uint256,uint256,bytes32[])');
    const challenge = W.cancelDigest({ account: A.account, chainId: A.chainId, id: id2 });
    const a = W.toContractAssertion(alice.getAssertion({ challenge, rpId: RP_ID, origin: ORIGIN }), alice.signerId, { challenge, rpId: RP_ID, origin: ORIGIN });
    const cancelled = await H.send(A.url, { from: A.relayer, to: A.account, data: W.encodeCancel(id2, a) });
    assert.equal(cancelled.status, '0x1');
    record('cancel a scheduled guarded call (1 assertion)', cancelled);
    await H.increaseTime(A.url, DELAY);
    assert.equal(
      await H.revertData(A.url, { to: A.account, data: W.encodeApplyCalls(id2, take) }),
      H.errorData('NothingPending(bytes32)', ['bytes32'], [id2]),
    );
    assert.equal(H.asAddress(await H.view(A.url, A.vault, 'agent()')), A.agent.toLowerCase());
    evidence.guardedCalls = { refusedImmediately: tries.length, delayedPathApplied: 'setDailyCap(4000e6)', cancelled: 'setAgent' };
  });

  test('a scheduled removal is cancelled with one Member assertion', async () => {
    const { receipt } = await execute(A, A.account, [alice], [{ target: A.account, value: 0n, data: W.encodeRemoveSigners([recKey.signerId]) }]);
    assert.equal(receipt.status, '0x1');
    record('execute: removeSigners -> scheduled change', receipt);
    const id = topicId(receipt, 'ChangeScheduled(bytes32,uint8,uint64,uint256,uint256,bytes32[])');
    const challenge = W.cancelDigest({ account: A.account, chainId: A.chainId, id });
    assert.equal(await H.view(A.url, A.account, 'cancelDigest(bytes32)', [id]), challenge);
    const a = W.toContractAssertion(alice.getAssertion({ challenge, rpId: RP_ID, origin: ORIGIN }), alice.signerId, { challenge, rpId: RP_ID, origin: ORIGIN });
    const r = await H.send(A.url, { from: A.relayer, to: A.account, data: W.encodeCancel(id, a) });
    assert.equal(r.status, '0x1');
    record('cancel (1 assertion)', r);
    assert.equal(topicId(r, 'ChangeCancelled(bytes32,bytes32)'), id);
  });

  test('recovery: a recovery-code key starts it, the delay runs, anyone finishes it, the new passkey can act', async () => {
    const dave = W.SoftwarePasskey.generate();
    const deadline = (await H.now(A.url)) + 3600n;
    const digest = W.recoveryDigest({ account: A.account, chainId: A.chainId, recoverySignerId: recKey.signerId, newX: dave.x, newY: dave.y, deadline });
    const { r, s } = new W.RecoveryKey(recoveryCode).signDigest(digest);
    const start = await H.send(A.url, { from: A.relayer, to: A.account, data: W.encodeStartRecovery(recKey.signerId, dave.x, dave.y, deadline, r, s) });
    assert.equal(start.status, '0x1');
    record('startRecovery (raw P-256)', start);
    const id = topicId(start, 'RecoveryStarted(bytes32,bytes32,bytes32,uint256,uint256,uint64)');
    const readyAt = (await H.now(A.url)) + RECOVERY_DELAY;
    const early = await H.revertData(A.url, { to: A.account, data: W.encodeFinishRecovery(id) });
    assert.equal(early.slice(0, 10), H.errorData('NotReady(bytes32,uint64)', ['bytes32', 'uint64'], [id, readyAt]).slice(0, 10));
    await H.increaseTime(A.url, RECOVERY_DELAY);
    const fin = await H.send(A.url, { from: A.payee, to: A.account, data: W.encodeFinishRecovery(id) });
    assert.equal(fin.status, '0x1');
    record('finishRecovery', fin);
    const role = H.word(await H.view(A.url, A.account, 'getSigner(bytes32)', [dave.signerId]), 2);
    assert.equal(role, 1n, 'dave is a Member');
    const { receipt } = await execute(A, A.account, [dave], [{ target: A.vault, value: 0n, data: W.encodeCall('revokeMandate(bytes32)', [W.bytesToHex(W.keccak256('by dave'))]) }]);
    assert.equal(receipt.status, '0x1');
    const revoked = W.bytesToHex(W.keccak256('MandateRevoked(bytes32)'));
    assert.ok(receipt.logs.some((l) => l.address.toLowerCase() === A.vault.toLowerCase() && l.topics[0] === revoked));
  });
});

describe('chain B (osaka, chain id 31338): the same account address on another chain', () => {
  test('signatures and batches from chain A are refused', async () => {
    chainB = await H.startAnvil({ hardfork: 'osaka', chainId: 31338 });
    const accts = (await H.rpc(chainB.url, 'eth_accounts', [])) as Hex[];
    const b = await H.deploy(chainB.url, accts[9], accountCode, accountArgs);
    assert.equal(b.address, A.account, 'same deployer and nonce: same address');
    assert.equal(await isValid(A.url, A.account, aliceMandateDigest, aliceMandateSig), W.ERC1271_MAGIC);
    assert.equal(await isValid(chainB.url, b.address, aliceMandateDigest, aliceMandateSig), W.ERC1271_INVALID);
    assert.equal(
      await H.revertData(chainB.url, { to: b.address, data: firstExecuteCalldata }),
      H.errorData('InvalidAssertion(uint256)', ['uint256'], [0n]),
    );
    evidence.chainB = { chainId: 31338, account: b.address, erc1271FromChainA: 'invalid', executeFromChainA: 'InvalidAssertion(0)' };
  });
});

describe('chain C (prague: no P-256 precompile)', () => {
  test('the account refuses to be deployed where it could never verify a passkey', async () => {
    chainC = await H.startAnvil({ hardfork: 'prague', chainId: 31339 });
    const accts = (await H.rpc(chainC.url, 'eth_accounts', [])) as Hex[];
    let data: Hex | undefined;
    try {
      await H.rpc(chainC.url, 'eth_call', [{ from: accts[0], data: (accountCode + accountArgs.slice(2)) as Hex }, 'latest']);
    } catch (e) {
      data = (e as H.RpcError).data;
    }
    assert.equal(data, H.errorData('MissingPrecompile(address)', ['address'], ['0x0000000000000000000000000000000000000100']));
    evidence.chainC = { hardfork: 'prague', deployment: 'reverted MissingPrecompile(0x100)' };
  });
});
