/**
 * QED Private — zero-knowledge proof that a portfolio is optimal for data nobody else sees.
 *
 * The circuit (circuits/private_minvar.circom) proves the same KKT certificate that MinVarianceVerifier
 * checks in public (docs/ALGORITHMS.md §4), but over a covariance matrix and a portfolio that stay
 * private: the chain sees only Poseidon commitments to both, the certified variance and the provider.
 *
 * This file is the untrusted, expensive side: it builds the fixed-point witness from the exact
 * optimum, computes the commitments, runs the Groth16 prover and encodes calldata. `checkWitness`
 * is a bit-exact re-implementation of every circuit constraint, used before proving and in tests.
 */
import { randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
// @ts-expect-error — snarkjs ships no type declarations
import * as snarkjs from "snarkjs";
// @ts-expect-error — circomlibjs ships no type declarations
import { buildPoseidon } from "circomlibjs";
import { encodeAbiParameters, keccak256, encodePacked, type Address, type Hex } from "viem";
import { cholesky, solveFloat } from "./minvar.js";

/** BN254 scalar field. */
export const FIELD = 21888242871839275222246405745257275088548364400416034343698204186575808495617n;
export const N = 6;
export const M = (N * (N + 1)) / 2; // 21 entries of a symmetric 6×6 matrix
export const ONE = 10n ** 12n;
export const TAU = 10n ** 14n; // τ = 1e-10 at scale ONE²
export const TAU_CS = 10n ** 26n; // τ = 1e-10 at scale ONE³

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../../..");
export const CIRCUIT = {
  wasm: join(ROOT, "circuits/build/private_minvar_js/private_minvar.wasm"),
  zkey: join(ROOT, "circuits/build/private_minvar_final.zkey"),
  vkey: join(ROOT, "circuits/private_minvar.vkey.json"),
};

/** Index of Σ(i, j) in the row-major upper triangle (Σ symmetric). Mirrors U() in the circuit. */
export const U = (i: number, j: number): number => {
  const [a, b] = i <= j ? [i, j] : [j, i];
  return a * N - (a * (a - 1)) / 2 + (b - a);
};
/** Index of L(i, j), j ≤ i, in the row-major lower triangle. Mirrors T() in the circuit. */
export const T = (i: number, j: number): number => (i * (i + 1)) / 2 + j;

const fe = (x: bigint): bigint => ((x % FIELD) + FIELD) % FIELD;
const abs = (x: bigint): bigint => (x < 0n ? -x : x);
const round = (x: number, scale: bigint): bigint => BigInt(Math.round(x * Number(scale)));

export interface PrivateData {
  cov: bigint[]; // M entries, upper triangle, scale ONE
  salt: bigint;
}

export interface PrivateWitness {
  cov: bigint[];
  saltData: bigint;
  w: bigint[];
  nu: bigint;
  mu: bigint[];
  L: bigint[];
  saltW: bigint;
  dataCommitment: bigint;
  provider: bigint;
}

export interface PublicSignals {
  weightsCommitment: bigint;
  variance: bigint; // wᵀΣw at scale ONE³
  dataCommitment: bigint;
  provider: bigint;
}

let poseidonP: Promise<any> | null = null;
async function poseidon(inputs: bigint[]): Promise<bigint> {
  poseidonP ??= buildPoseidon();
  const p = await poseidonP;
  return p.F.toObject(p(inputs.map(fe)));
}

export const randomSalt = (): bigint => fe(BigInt("0x" + randomBytes(31).toString("hex")));

/** The vendor's commitment to its covariance model: Poseidon(Poseidon(Σ[0..10]), Poseidon(Σ[11..20], salt)). */
export async function commitData(d: PrivateData): Promise<bigint> {
  const H = (M + 1) / 2;
  const a = await poseidon(d.cov.slice(0, H));
  const b = await poseidon([...d.cov.slice(H), d.salt]);
  return poseidon([a, b]);
}

export const commitWeights = (w: bigint[], salt: bigint): Promise<bigint> => poseidon([...w, salt]);

/** Fixed-point covariance (upper triangle, scale ONE) from a float matrix. */
export function covToFixed(S: number[][]): bigint[] {
  const out: bigint[] = new Array(M);
  for (let i = 0; i < N; i++) for (let j = i; j < N; j++) out[U(i, j)] = round(S[i][j], ONE);
  return out;
}

export function covFromFixed(cov: bigint[]): number[][] {
  return Array.from({ length: N }, (_, i) => Array.from({ length: N }, (_, j) => Number(cov[U(i, j)]) / Number(ONE)));
}

export function gradient(cov: bigint[], w: bigint[]): bigint[] {
  return Array.from({ length: N }, (_, i) => {
    let s = 0n;
    for (let j = 0; j < N; j++) s += cov[U(i, j)] * w[j];
    return s;
  });
}

/** The optimum and its KKT certificate in the circuit's fixed point (exact integers). */
export function certifyFixed(cov: bigint[]): { w: bigint[]; nu: bigint; mu: bigint[]; L: bigint[]; support: number[] } {
  const S = covFromFixed(cov);
  const { w: wf, support } = solveFloat(S);
  const inS = new Set(support);
  const w = wf.map((x, i) => (inS.has(i) ? round(x, ONE) : 0n)).map((x) => (x < 0n ? 0n : x));
  let iMax = 0;
  for (let i = 1; i < N; i++) if (w[i] > w[iMax]) iMax = i;
  w[iMax] += ONE - w.reduce((a, b) => a + b, 0n); // budget exactly 1
  const g = gradient(cov, w);
  let acc = 0n;
  for (const i of support) acc += g[i];
  const k = BigInt(support.length);
  const nu = (acc + (acc >= 0n ? k / 2n : -k / 2n)) / k; // mean gradient on the support, rounded
  const mu = g.map((gi, i) => (inS.has(i) ? 0n : gi - nu > 0n ? gi - nu : 0n));
  const Lf = cholesky(S);
  const L: bigint[] = new Array(M);
  for (let i = 0; i < N; i++) for (let j = 0; j <= i; j++) L[T(i, j)] = round(Lf[i][j], ONE);
  return { w, nu, mu, L, support };
}

export interface WitnessReport {
  ok: boolean;
  violations: string[];
  maxStationarity: bigint; // scale ONE²
  gap: bigint; // scale ONE³
  maxPsd: bigint; // scale ONE²
  variance: bigint; // scale ONE³
}

/** Bit-exact mirror of every arithmetic constraint in the circuit (commitments excluded). */
export function checkWitness(x: Pick<PrivateWitness, "cov" | "w" | "nu" | "mu" | "L">): WitnessReport {
  const v: string[] = [];
  const within = (val: bigint, lo: bigint, hi: bigint) => val >= lo && val < hi;
  for (let k = 0; k < M; k++) {
    if (!within(x.cov[k], -(2n ** 40n), 2n ** 40n)) v.push(`cov[${k}] out of range`);
    if (!within(x.L[k], -(2n ** 40n), 2n ** 40n)) v.push(`L[${k}] out of range`);
  }
  for (let i = 0; i < N; i++) if (!within(x.cov[U(i, i)] - 1n, 0n, 2n ** 40n)) v.push(`variance ${i} not positive`);
  if (!within(x.nu, -(2n ** 80n), 2n ** 80n)) v.push("nu out of range");
  let sumW = 0n;
  for (let i = 0; i < N; i++) {
    if (!within(x.w[i], 0n, 2n ** 40n)) v.push(`w[${i}] negative or too large`);
    if (!within(x.mu[i], 0n, 2n ** 80n)) v.push(`mu[${i}] negative or too large`);
    sumW += x.w[i];
  }
  if (sumW !== ONE) v.push(`budget ${sumW} != ${ONE}`);
  const g = gradient(x.cov, x.w);
  let maxStat = 0n;
  let gap = 0n;
  let variance = 0n;
  for (let i = 0; i < N; i++) {
    const r = g[i] - x.nu - x.mu[i];
    if (abs(r) > maxStat) maxStat = abs(r);
    if (abs(r) > TAU) v.push(`stationarity ${i}: |r| = ${abs(r)}`);
    gap += x.w[i] * x.mu[i];
    variance += x.w[i] * g[i];
  }
  if (gap > TAU_CS) v.push(`complementary slackness: gap ${gap}`);
  let maxPsd = 0n;
  for (let i = 0; i < N; i++)
    for (let j = 0; j <= i; j++) {
      let s = 0n;
      for (let k = 0; k <= j; k++) s += x.L[T(i, k)] * x.L[T(j, k)];
      const e = x.cov[U(j, i)] * ONE - s;
      if (abs(e) > maxPsd) maxPsd = abs(e);
      if (abs(e) > TAU) v.push(`convexity (${i},${j}): |e| = ${abs(e)}`);
    }
  return { ok: v.length === 0, violations: v, maxStationarity: maxStat, gap, maxPsd, variance };
}

/** Circuit input (decimal strings; negatives in the field's encoding). */
export function circuitInput(x: PrivateWitness): Record<string, string | string[]> {
  const s = (b: bigint) => fe(b).toString();
  return {
    cov: x.cov.map(s),
    saltData: s(x.saltData),
    w: x.w.map(s),
    nu: s(x.nu),
    mu: x.mu.map(s),
    L: x.L.map(s),
    saltW: s(x.saltW),
    dataCommitment: s(x.dataCommitment),
    provider: s(x.provider),
  };
}

export interface Groth16Calldata {
  a: [bigint, bigint];
  b: [[bigint, bigint], [bigint, bigint]];
  c: [bigint, bigint];
}

export interface PrivateProof {
  calldata: Groth16Calldata;
  signals: PublicSignals;
  raw: { proof: any; publicSignals: string[] };
  provingMs: number;
}

/** Run the Groth16 prover. Throws if the witness violates any constraint (no proof can exist). */
export async function prove(x: PrivateWitness): Promise<PrivateProof> {
  const t0 = performance.now();
  const { proof, publicSignals } = await snarkjs.groth16.fullProve(circuitInput(x), CIRCUIT.wasm, CIRCUIT.zkey);
  const provingMs = performance.now() - t0;
  const P = (v: string) => BigInt(v);
  return {
    calldata: {
      a: [P(proof.pi_a[0]), P(proof.pi_a[1])],
      // the pairing precompile takes G2 coordinates as (imaginary, real)
      b: [
        [P(proof.pi_b[0][1]), P(proof.pi_b[0][0])],
        [P(proof.pi_b[1][1]), P(proof.pi_b[1][0])],
      ],
      c: [P(proof.pi_c[0]), P(proof.pi_c[1])],
    },
    signals: {
      weightsCommitment: P(publicSignals[0]),
      variance: P(publicSignals[1]),
      dataCommitment: P(publicSignals[2]),
      provider: P(publicSignals[3]),
    },
    raw: { proof, publicSignals },
    provingMs,
  };
}

export async function verifyOffchain(vkey: any, raw: { proof: any; publicSignals: string[] }): Promise<boolean> {
  return snarkjs.groth16.verify(vkey, raw.publicSignals, raw.proof);
}

/** Lets the prover's worker threads exit (snarkjs keeps a curve singleton alive). */
export async function shutdownProver(): Promise<void> {
  const curve = (globalThis as any).curve_bn128;
  if (curve?.terminate) await curve.terminate();
}

// ─────────────────────────── vendor attestation and ABI codecs (PrivateMinVarianceVerifier) ───────────────────────────

/** Domain tag the vendor signs over; must equal PrivateMinVarianceVerifier.ATTESTATION_TAG. */
export const ATTESTATION_TAG = keccak256(encodePacked(["string"], ["QED Private: data attestation v1"]));

/** Digest the vendor signs (EIP-191 personal_sign over these 32 bytes). */
export function attestationDigest(chainId: bigint, dataCommitment: bigint, universe: Hex): Hex {
  return keccak256(
    encodeAbiParameters([{ type: "bytes32" }, { type: "uint256" }, { type: "uint256" }, { type: "bytes32" }], [ATTESTATION_TAG, chainId, dataCommitment, universe]),
  );
}

export interface PrivateSpec {
  dataCommitment: bigint;
  universe: Hex;
  provider: Address;
  vendorSig: Hex;
}

export function encodePrivateSpec(s: PrivateSpec): Hex {
  return encodeAbiParameters(
    [{ type: "uint256" }, { type: "bytes32" }, { type: "address" }, { type: "bytes" }],
    [s.dataCommitment, s.universe, s.provider, s.vendorSig],
  );
}

export function encodePrivateSolution(c: Groth16Calldata, weightsCommitment: bigint, variance: bigint): Hex {
  return encodeAbiParameters(
    [{ type: "uint256[2]" }, { type: "uint256[2][2]" }, { type: "uint256[2]" }, { type: "uint256" }, { type: "uint256" }],
    [c.a, c.b, c.c, weightsCommitment, variance],
  );
}

/** resultDigest returned by the verifier and recorded by ProofEscrow at settlement. */
export const privateResultDigest = (weightsCommitment: bigint, variance: bigint): Hex =>
  keccak256(encodeAbiParameters([{ type: "uint256" }, { type: "uint256" }], [weightsCommitment, variance]));
