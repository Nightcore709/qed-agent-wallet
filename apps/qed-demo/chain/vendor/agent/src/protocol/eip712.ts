/**
 * EIP-712 typed data shared by every role. Field order and names MUST match the Solidity
 * typehashes in QEDVault.sol and ProofEscrow.sol (parity is asserted in agent/test/parity.test.ts
 * against the deployed bytecode).
 */
import { hashStruct, hashTypedData, type Address, type Hex, type LocalAccount } from "viem";

export interface Mandate {
  vault: Address;
  agent: Address;
  payees: Address[];
  maxPerPayment: bigint;
  maxPerPeriod: bigint;
  period: bigint;
  maxTotal: bigint;
  validFrom: bigint;
  validUntil: bigint;
  epoch: bigint;
  requireCosign: boolean;
  purpose: Hex;
  salt: Hex;
}

export interface Certificate {
  mandateHash: Hex;
  recipient: Address;
  amount: bigint;
  dueAt: bigint;
  intentId: Hex;
  evidenceHash: Hex;
  ref: Hex;
  notBefore: bigint;
  expiresAt: bigint;
  epoch: bigint;
}

export interface Quote {
  provider: Address;
  payee: Address;
  client: Address;
  token: Address;
  price: bigint;
  verifier: Address;
  specHash: Hex;
  deliverBy: bigint;
  validUntil: bigint;
  quoteId: Hex;
}

export const MandateTypes = {
  Mandate: [
    { name: "vault", type: "address" },
    { name: "agent", type: "address" },
    { name: "payees", type: "address[]" },
    { name: "maxPerPayment", type: "uint256" },
    { name: "maxPerPeriod", type: "uint256" },
    { name: "period", type: "uint64" },
    { name: "maxTotal", type: "uint256" },
    { name: "validFrom", type: "uint64" },
    { name: "validUntil", type: "uint64" },
    { name: "epoch", type: "uint64" },
    { name: "requireCosign", type: "bool" },
    { name: "purpose", type: "bytes32" },
    { name: "salt", type: "bytes32" },
  ],
} as const;

export const CertificateTypes = {
  Certificate: [
    { name: "mandateHash", type: "bytes32" },
    { name: "recipient", type: "address" },
    { name: "amount", type: "uint256" },
    { name: "dueAt", type: "uint64" },
    { name: "intentId", type: "bytes32" },
    { name: "evidenceHash", type: "bytes32" },
    { name: "ref", type: "bytes32" },
    { name: "notBefore", type: "uint64" },
    { name: "expiresAt", type: "uint64" },
    { name: "epoch", type: "uint64" },
  ],
} as const;

export const QuoteTypes = {
  Quote: [
    { name: "provider", type: "address" },
    { name: "payee", type: "address" },
    { name: "client", type: "address" },
    { name: "token", type: "address" },
    { name: "price", type: "uint256" },
    { name: "verifier", type: "address" },
    { name: "specHash", type: "bytes32" },
    { name: "deliverBy", type: "uint64" },
    { name: "validUntil", type: "uint64" },
    { name: "quoteId", type: "bytes32" },
  ],
} as const;

export const vaultDomain = (chainId: number, vault: Address) =>
  ({ name: "QEDVault", version: "1", chainId, verifyingContract: vault }) as const;

export const escrowDomain = (chainId: number, escrow: Address) =>
  ({ name: "ProofEscrow", version: "1", chainId, verifyingContract: escrow }) as const;

export const mandateHash = (m: Mandate): Hex =>
  hashStruct({ data: m as any, primaryType: "Mandate", types: MandateTypes as any });

export const mandateDigest = (chainId: number, m: Mandate): Hex =>
  hashTypedData({ domain: vaultDomain(chainId, m.vault), types: MandateTypes, primaryType: "Mandate", message: m as any });

export const certificateDigest = (chainId: number, vault: Address, c: Certificate): Hex =>
  hashTypedData({ domain: vaultDomain(chainId, vault), types: CertificateTypes, primaryType: "Certificate", message: c as any });

export const quoteHash = (q: Quote): Hex =>
  hashStruct({ data: q as any, primaryType: "Quote", types: QuoteTypes as any });

export const quoteDigest = (chainId: number, escrow: Address, q: Quote): Hex =>
  hashTypedData({ domain: escrowDomain(chainId, escrow), types: QuoteTypes, primaryType: "Quote", message: q as any });

export const signMandate = (owner: LocalAccount, chainId: number, m: Mandate) =>
  owner.signTypedData({ domain: vaultDomain(chainId, m.vault), types: MandateTypes, primaryType: "Mandate", message: m as any });

export const signCertificate = (cosigner: LocalAccount, chainId: number, vault: Address, c: Certificate) =>
  cosigner.signTypedData({ domain: vaultDomain(chainId, vault), types: CertificateTypes, primaryType: "Certificate", message: c as any });

export const signQuote = (provider: LocalAccount, chainId: number, escrow: Address, q: Quote) =>
  provider.signTypedData({ domain: escrowDomain(chainId, escrow), types: QuoteTypes, primaryType: "Quote", message: q as any });

/** JSON helpers: bigint-safe (de)serialisation for messages passed between agent processes. */
export const toJson = (x: unknown): string =>
  JSON.stringify(x, (_, v) => (typeof v === "bigint" ? { $big: v.toString() } : v), 2);
export const fromJson = <T>(s: string): T =>
  JSON.parse(s, (_, v) => (v && typeof v === "object" && "$big" in v ? BigInt(v.$big) : v)) as T;
