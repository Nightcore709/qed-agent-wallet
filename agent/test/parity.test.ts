/**
 * Cross-language parity: TypeScript EIP-712 hashing and fixed-point KKT checking must agree
 * bit-for-bit with the deployed Solidity. Spins up a throwaway anvil (Foundry) node.
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createPublicClient, createWalletClient, http, keccak256, toHex, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { foundry } from "viem/chains";
import { MinVarianceVerifierAbi, MinVarianceVerifierBytecode, QEDLensAbi, QEDLensBytecode, QEDVaultAbi, QEDVaultBytecode, TestUSDAbi, TestUSDBytecode, ProofEscrowAbi, ProofEscrowBytecode } from "../src/abi/contracts.js";
import { certificateDigest, mandateDigest, mandateHash, quoteDigest, type Certificate, type Mandate, type Quote } from "../src/protocol/eip712.js";
import { certify, checkCertificate } from "../src/engine/minvar.js";
import { encodeSolution, encodeSpec, helixSpec } from "../src/engine/riskModel.js";

const PORT = 8611;
const anvil = spawn("anvil", ["--port", String(PORT), "--silent"], { stdio: "ignore" });
after(() => anvil.kill());
const pub = createPublicClient({ chain: foundry, transport: http(`http://127.0.0.1:${PORT}`) });
const dev = privateKeyToAccount("0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80"); // anvil #0
const wallet = createWalletClient({ account: dev, chain: foundry, transport: http(`http://127.0.0.1:${PORT}`) });

async function ready() {
  for (let i = 0; i < 100; i++) {
    try {
      await pub.getChainId();
      return;
    } catch {
      await new Promise((r) => setTimeout(r, 100));
    }
  }
}
async function deploy(abi: any, bytecode: Hex, args: any[] = []) {
  const hash = await wallet.deployContract({ abi, bytecode, args } as any);
  return (await pub.waitForTransactionReceipt({ hash })).contractAddress!;
}

test("EIP-712 digests + KKT checker: TypeScript ≡ Solidity", async () => {
  await ready();
  const token = await deploy(TestUSDAbi, TestUSDBytecode);
  const vault = await deploy(QEDVaultAbi, QEDVaultBytecode, [token, dev.address, dev.address, dev.address, dev.address, 25_000_000n]);
  const lens = await deploy(QEDLensAbi, QEDLensBytecode);
  const escrow = await deploy(ProofEscrowAbi, ProofEscrowBytecode);
  const verifier = await deploy(MinVarianceVerifierAbi, MinVarianceVerifierBytecode);
  const chainId = await pub.getChainId();

  const m: Mandate = {
    vault,
    agent: dev.address,
    payees: [dev.address, token],
    maxPerPayment: 1n,
    maxPerPeriod: 2n,
    period: 3n,
    maxTotal: 4n,
    validFrom: 5n,
    validUntil: 6n,
    epoch: 0n,
    requireCosign: true,
    purpose: keccak256(toHex("p")),
    salt: keccak256(toHex("s")),
  };
  assert.equal(await pub.readContract({ address: lens, abi: QEDLensAbi, functionName: "hashMandate", args: [m] as any }), mandateHash(m));
  assert.equal(await pub.readContract({ address: lens, abi: QEDLensAbi, functionName: "mandateDigest", args: [vault, m] as any }), mandateDigest(chainId, m));

  const c: Certificate = { mandateHash: mandateHash(m), recipient: token, amount: 7n, dueAt: 8n, intentId: keccak256(toHex("i")), evidenceHash: keccak256(toHex("e")), ref: keccak256(toHex("r")), notBefore: 9n, expiresAt: 10n, epoch: 0n };
  assert.equal(await pub.readContract({ address: lens, abi: QEDLensAbi, functionName: "certificateDigest", args: [vault, c] as any }), certificateDigest(chainId, vault, c));

  const q: Quote = { provider: dev.address, payee: vault, client: token, token, price: 15n, verifier, specHash: keccak256(toHex("spec")), deliverBy: 11n, validUntil: 12n, quoteId: keccak256(toHex("q")) };
  assert.equal(await pub.readContract({ address: escrow, abi: ProofEscrowAbi, functionName: "quoteDigest", args: [q] as any }), quoteDigest(chainId, escrow, q));

  const spec = helixSpec();
  const sol = certify(spec);
  const onchain = (await pub.readContract({ address: verifier, abi: MinVarianceVerifierAbi, functionName: "verify", args: [encodeSpec(spec), encodeSolution(sol)] })) as Hex;
  assert.equal(BigInt(onchain), checkCertificate(spec, sol).variance, "certified variance identical");
});
