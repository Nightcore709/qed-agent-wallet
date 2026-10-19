/**
 * Writes contracts/test/fixtures/private.json: a real Groth16 proof of private optimality (and the data
 * the Solidity tests need to attack it). Keys are fixed test keys; the attestation is for chain 31337.
 *   npm run fixtures:private
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { numberToHex, toHex, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import {
  attestationDigest,
  certifyFixed,
  checkWitness,
  commitData,
  commitWeights,
  encodePrivateSolution,
  encodePrivateSpec,
  privateResultDigest,
  prove,
  shutdownProver,
} from "../src/engine/privateMinvar.js";
import { privateCovariance, PRIVATE_UNIVERSE } from "../src/engine/privateScenario.js";

const pk = (n: bigint): Hex => numberToHex(n, { size: 32 });
const VENDOR = privateKeyToAccount(pk(0x4e11cn)); // the data vendor's attestation key
const IMPOSTOR = privateKeyToAccount(pk(0xbadc0den)); // anyone else
const PROVIDER_PK = 0x51edn; // QED's private-desk key
const MALLORY_PK = 0xbadn;
const provider = privateKeyToAccount(pk(PROVIDER_PK));
const mallory = privateKeyToAccount(pk(MALLORY_PK));

// Deterministic salts for a reproducible fixture (the live run draws fresh random salts).
const saltData = 0x5a17da7an;
const saltW = 0x5a17ee16n;

const cov = privateCovariance();
const cert = certifyFixed(cov);
const report = checkWitness({ cov, ...cert });
if (!report.ok) throw new Error("witness violates the circuit: " + report.violations.join("; "));
const dataCommitment = await commitData({ cov, salt: saltData });
const digest = attestationDigest(31337n, dataCommitment, PRIVATE_UNIVERSE);
const vendorSig = await VENDOR.signMessage({ message: { raw: digest } });
const impostorSig = await IMPOSTOR.signMessage({ message: { raw: digest } });

const proof = await prove({ cov, saltData, ...cert, saltW, dataCommitment, provider: BigInt(provider.address) });
const wc = await commitWeights(cert.w, saltW);
if (wc !== proof.signals.weightsCommitment) throw new Error("weights commitment mismatch");

const spec = encodePrivateSpec({ dataCommitment, universe: PRIVATE_UNIVERSE, provider: provider.address, vendorSig });
const fixture = {
  vendor: VENDOR.address,
  impostor: IMPOSTOR.address,
  providerPk: toHex(PROVIDER_PK),
  malloryPk: toHex(MALLORY_PK),
  provider: provider.address,
  mallory: mallory.address,
  universe: PRIVATE_UNIVERSE,
  dataCommitment: dataCommitment.toString(),
  weightsCommitment: proof.signals.weightsCommitment.toString(),
  variance: proof.signals.variance.toString(),
  vendorSig,
  impostorSig,
  spec,
  specForMallory: encodePrivateSpec({ dataCommitment, universe: PRIVATE_UNIVERSE, provider: mallory.address, vendorSig }),
  specImpostor: encodePrivateSpec({ dataCommitment, universe: PRIVATE_UNIVERSE, provider: provider.address, vendorSig: impostorSig }),
  solution: encodePrivateSolution(proof.calldata, proof.signals.weightsCommitment, proof.signals.variance),
  proof: {
    a: proof.calldata.a.map(String),
    b: proof.calldata.b.map((r) => r.map(String)),
    c: proof.calldata.c.map(String),
  },
  resultDigest: privateResultDigest(proof.signals.weightsCommitment, proof.signals.variance),
  // revealed to the client off-chain only; here so tests can re-check the commitment
  weights: cert.w.map(String),
  saltW: saltW.toString(),
  provingMs: Math.round(proof.provingMs),
};
mkdirSync("contracts/test/fixtures", { recursive: true });
writeFileSync("contracts/test/fixtures/private.json", JSON.stringify(fixture, null, 1));
console.log(`wrote contracts/test/fixtures/private.json — proof in ${fixture.provingMs} ms, variance ${(Number(proof.signals.variance) / 1e36).toFixed(10)}`);
await shutdownProver();
