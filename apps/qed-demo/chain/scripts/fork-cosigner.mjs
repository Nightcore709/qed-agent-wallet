#!/usr/bin/env node
/**
 * Generates rail/cosigner-engine.ts, the rail's fork of the release's co-signer (vendor/agent/src/roles/cosigner.ts,
 * which stays unmodified), by exact, counted text replacements. Decision D-A (22 Nov 2026, taken by the R7 orchestrator,
 * not by the owner; docs/r7/00-ARCHITECTURE-DECISIONS.md): change only
 *
 *   1. how the owner's signatures are checked: as the vault checks them (OpenZeppelin SignatureChecker): ECDSA
 *      recovery for an owner without code, exactly as the release does, and ERC-1271 isValidSignature for a contract
 *      owner (a workspace's passkey account). Affects C1 (mandate) and C3 (owner instruction, conversion, policy);
 *   2. the asset-dependent constants: the reserve buffer (5 units), the earned-autonomy base (10 units) and the
 *      formatting of amounts in records, in the decimals of the vault's own asset (read from the chain), so a
 *      2-decimal tINR vault is checked and described in rupees, not in micro-dollars.
 *
 * And, only when the engine's configuration says `authority: "d7"` (every workspace created through POST /workspaces;
 * R7 decision D7, docs/r7/00-ARCHITECTURE-DECISIONS.md D7 and experiments/r7/S1-science/D7-authority-budget.md):
 *   3. check C12 is the authority budget (rail/authority.ts, rail/authority-ledger.ts) instead of the release's earned
 *      allowance: payments to others consume it, a conversion only its cost against a reference band, earnings add
 *      only after settlement from clients outside the workspace's principal set, owner grants add as granted. C12
 *      keeps its id and its place among a payment's checks; a conversion gains C12 as its last check, because its worst
 *      case needs the co-signer's own quote and floor. Certificates signed and not yet used reserve their worst case.
 *      Without `authority`, or with "release", the fork keeps the release's C12 (in the vault's units, change 2), so
 *      the differential test against the release's engine holds as before.
 *
 * And, for every engine this script generates (decision D-K4a, R13; the owner asked that every gap be fixed; finding F-018
 * in docs/research/qed-math-formal/20261124-k1-earned-authority.md section 9):
 *   5. each named check of a conversion can fail alone. In the release, P1 fails only with P2 (P2's condition contains
 *      P1's), P3 only with P2 (the co-signer's own tranche is already cut to the impact limit), T1 only with T2 (no route,
 *      no rate), and T3 cannot fail on a chain (it checks only that the hash is 32 bytes). So:
 *      P2  "if a tranche is due, the request is no larger than the tranche the policy allows (the shortfall's tranche,
 *          the policy's and the mandate's caps, the free funds) and no smaller than its smallest". The cost limit is P3's
 *          alone; with no tranche due, P2 holds and P1 refuses.
 *      T2  is computed only when T1 passes: without a route that executes there is no quoted rate to screen.
 *      T3  checks the venue set the order commits to against the venues the co-signer read and solved over: the hash
 *          QEDExecution keeps, keccak256(abi.encode(venues)), recomputed from them. A venue set changed between the two
 *          reads, or a module whose hash is not its venues', fails it.
 *      The verdict is unchanged wherever the release's impact search is exact (the execution cost rising with the size):
 *      P1∧P2∧P3 and T1∧T2 are the release's conjunctions, and T3 passes on every chain state the release accepts whose
 *      venue set did not change between the two reads (test/checks-alone.test.ts, test/cosigner-fork.test.ts).
 *
 * And, only when the engine's configuration sets `minToleranceUnits` (money-model S5: a workspace whose currency set is
 * not the default, shared/chain-assets.ts):
 *   6. the order's best-execution tolerance τ never asks for less than that many base units of the output token: the
 *      on-chain bound is rounded up and each hop's output down, so an output of a 0-decimal token (tJPY) cannot come
 *      within the release's 1 to 100 ppm of the bound when one unit is hundreds of ppm of it. τ is the release's rule,
 *      raised to ⌈units · 10⁶ / quoted output⌉ where that is larger, and never above QEDExecution's MAX_TOLERANCE_PPM
 *      (1%). Without the setting (the baseline, every default workspace, the differential test) τ is the release's.
 *
 * Everything else is the release's text, character for character. Every replacement must match exactly the stated
 * number of times, or nothing is written.
 *
 *   node scripts/fork-cosigner.mjs           write rail/cosigner-engine.ts
 *   node scripts/fork-cosigner.mjs --check   exit 1 unless the file on disk is exactly what this script generates
 */
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const CHAIN = join(dirname(fileURLToPath(import.meta.url)), "..");
const SOURCE = join(CHAIN, "vendor", "agent", "src", "roles", "cosigner.ts");
const TARGET = join(CHAIN, "rail", "cosigner-engine.ts");

export function generate(src = readFileSync(SOURCE, "utf8")) {
  const start = src.indexOf("export class PolicyEngine {");
  if (start < 0) throw new Error("PolicyEngine not found in the vendored co-signer");
  let body = src.slice(start);
  const swap = (from, to, times) => {
    const n = body.split(from).length - 1;
    if (n !== times) throw new Error(`expected ${times} occurrence(s) of ${JSON.stringify(from.slice(0, 80))}, found ${n}`);
    body = body.split(from).join(to);
  };
  // the class itself, without TypeScript parameter properties (the rail's files are erasable TypeScript)
  swap("export class PolicyEngine {", "class ForkedPolicyEngine {", 1);
  swap("  constructor(\n    private chain: Chain$,\n    private key: LocalAccount,\n    private cfg: CosignerConfig,\n  ) {\n    mkdirSync(cfg.recordsDir, { recursive: true });\n  }",
    "  private chain: Chain$;\n  private key: LocalAccount;\n  private cfg: ForkCosignerConfig;\n  constructor(chain: Chain$, key: LocalAccount, cfg: ForkCosignerConfig) {\n    this.chain = chain;\n    this.key = key;\n    this.cfg = cfg;\n    if (cfg.authority === \"d7\" && !cfg.d7) throw new Error('authority \"d7\" needs its configuration (d7): the co-signer was not started');\n    mkdirSync(cfg.recordsDir, { recursive: true });\n  }", 1);

  // ── change 1: owner signatures as the vault checks them ──
  swap('    const { recoverAddress } = await import("viem");\n', "", 2);
  swap('    const signer = await recoverAddress({ hash: digest, signature: req.ownerSig }).catch(() => "0x0" as Address);\n    add("C1", "Mandate signed by the vault owner", getAddress(signer) === getAddress(snap.owner), `recovered ${signer}`);',
    '    const signer = await this.ownerSigned(snap.owner, digest, req.ownerSig, "recovered");\n    add("C1", "Mandate signed by the vault owner", signer.ok, signer.detail);', 2);
  swap('      const s = await recoverMessageAddress({ message: msg, signature: req.instructionSig }).catch(() => "0x0" as Address);\n      add("C3", "Instruction confirmed by the owner\'s signature", getAddress(s) === getAddress(snap.owner), `instruction signer ${s}`);',
    '      const s = await this.ownerSignedMessage(snap.owner, msg, req.instructionSig, "instruction signer");\n      add("C3", "Instruction confirmed by the owner\'s signature", s.ok, s.detail);', 1);
  swap('      const s = await recoverMessageAddress({ message: policyMessage(p), signature: req.policySig ?? "0x" }).catch(() => "0x0" as Address);',
    '      const s = await this.ownerSignedMessage(snap.owner, policyMessage(p), req.policySig ?? "0x", "policy signer");', 1);
  swap("getAddress(s) === getAddress(snap.owner) && BigInt(now) <= p.validUntil && fits, `policy signer ${s}, valid until",
    "s.ok && BigInt(now) <= p.validUntil && fits, `${s.detail}, valid until", 1);
  swap('      const s = await recoverMessageAddress({ message: msg, signature: req.instructionSig ?? "0x" }).catch(() => "0x0" as Address);\n      add("C3", "Conversion confirmed by the owner\'s signature", getAddress(s) === getAddress(snap.owner), `instruction signer ${s}`);',
    '      const s = await this.ownerSignedMessage(snap.owner, msg, req.instructionSig ?? "0x", "instruction signer");\n      add("C3", "Conversion confirmed by the owner\'s signature", s.ok, s.detail);', 1);

  // ── change 2: constants and record texts in the units of the vault's own asset ──
  swap("  async evaluate(req: CertRequest): Promise<CertResponse> {\n    const pub = this.chain.pub;\n", "  async evaluate(req: CertRequest): Promise<CertResponse> {\n    const pub = this.chain.pub;\n    await this.loadUnits();\n", 1);
  swap("  async evaluateTrade(req: TradeRequest): Promise<TradeResponse> {\n    const pub = this.chain.pub;\n", "  async evaluateTrade(req: TradeRequest): Promise<TradeResponse> {\n    const pub = this.chain.pub;\n    await this.loadUnits();\n", 1);
  swap("POLICY.reserveBuffer", "this.reserveBuffer", 5);
  swap("const allowance = 10_000_000n + revenue / 2n;", "const allowance = this.earnedBase + revenue / 2n;", 1);

  // ── change 3 (R7 D7, only with authority "d7"): C12 is the authority budget ──
  const releaseC12 = "    const { revenue, spent } = await this.trackRecord();\n    const allowance = this.earnedBase + revenue / 2n;\n    add(\"C12\", \"Earned autonomy: discretionary spend ≤ 10 + 50% of VERIFIED revenue\", spent + amount <= allowance, `spent ${fmt(spent)} + ${fmt(amount)} ≤ allowance ${fmt(allowance)} (verified revenue ${fmt(revenue)})`);\n";
  swap(releaseC12,
    "    let authorityHold: { cost: bigint; kind: Reservation[\"kind\"] } | null = null;\n" +
    "    if (this.authorityRule === \"d7\") {\n" +
    "      // R7 decision D7: C12 is the authority budget (rail/authority-ledger.ts), not the release's earned allowance\n" +
    "      const c12 = await this.authorityForPayment(snap, payee, amount, dueAt > 0n, now);\n" +
    "      authorityHold = c12.hold;\n" +
    "      add(\"C12\", c12.name, c12.pass, c12.detail);\n" +
    "    } else {\n" + releaseC12.split("\n").filter(Boolean).map((l) => `  ${l}`).join("\n") + "\n    }\n", 1);
  swap("      signature = await signCertificate(this.key, this.chain.chainId, this.cfg.vault, certificate);\n      if (req.kind === \"purchase\") this.seenInvoices.add(req.invoice.invoiceId);\n      else this.seenNonces.add(req.nonce);\n",
    "      signature = await signCertificate(this.key, this.chain.chainId, this.cfg.vault, certificate);\n      if (req.kind === \"purchase\") this.seenInvoices.add(req.invoice.invoiceId);\n      else this.seenNonces.add(req.nonce);\n      if (authorityHold) this.reserveAuthority(certificate, authorityHold);\n", 1);
  swap("      venueSetHash,\n    };\n    const approved = checks.every((c) => c.pass);\n    const intentId = keccak256(toHex(`trade:${req.nonce}`));\n",
    "      venueSetHash,\n    };\n" +
    "    let authorityHold: { cost: bigint; kind: Reservation[\"kind\"] } | null = null;\n" +
    "    if (this.authorityRule === \"d7\") {\n" +
    "      // R7 decision D7: the conversion's worst-case cost against the reference must fit in the authority budget\n" +
    "      const c12 = await this.authorityForTrade(snap, req, order, wMid, now);\n" +
    "      authorityHold = c12.hold;\n" +
    "      add(\"C12\", c12.name, c12.pass, c12.detail);\n" +
    "    }\n" +
    "    const approved = checks.every((c) => c.pass);\n    const intentId = keccak256(toHex(`trade:${req.nonce}`));\n", 1);
  // ── change 4 (R7 D7, only with authority "d7"; experiments/r8/D7-validation, F-R8-4): a conversion's certificate
  // lives 15 minutes, not the release's 4 hours. Its worst case is reserved until it is used or expires (change 3); a
  // conversion that reverts (an outside trade between the agent's plan and its block: NotBestExecution) used to hold
  // that room for 4 hours. The conversion job sends its trade seconds after the certificate is signed.
  swap("notBefore: BigInt(now - 60), expiresAt: BigInt(now + 4 * 3600), epoch: req.mandate.epoch };",
    "notBefore: BigInt(now - 60), expiresAt: BigInt(now + (this.authorityRule === \"d7\" ? D7_CONVERSION_CERTIFICATE_SECONDS : 4 * 3600)), epoch: req.mandate.epoch };", 1);
  swap("      signature = await signCertificate(this.key, this.chain.chainId, this.cfg.vault, certificate);\n      this.seenNonces.add(req.nonce);\n",
    "      signature = await signCertificate(this.key, this.chain.chainId, this.cfg.vault, certificate);\n      this.seenNonces.add(req.nonce);\n      if (authorityHold) this.reserveAuthority(certificate, authorityHold);\n", 1);

  // ── change 5 (D-K4a, F-018): each named check of a conversion can fail alone ──
  swap('      add("P2", "Requested tranche no larger than the co-signer\'s own decision", own.action === "convert" && req.amountIn <= own.amountIn && req.amountIn >= p.minTranche, `requested ${req.amountIn} ≤ allowed ${own.amountIn}`);\n',
    "      // D-K4a: P2 asks only what P1 does not, and leaves the cost limit to P3\n" +
    "      const due = own.action === \"convert\", sized = policyTranche(own.candidates);\n" +
    "      add(\"P2\", \"If a tranche is due, the request is no larger than the tranche the policy allows and no smaller than its smallest\", !due || (req.amountIn <= sized && req.amountIn >= p.minTranche), due ? `requested ${req.amountIn} ≤ allowed ${sized} (the shortfall's tranche ${own.candidates.need ?? \"beyond the caps\"}, policy cap ${own.candidates.policyCap}, mandate cap ${own.candidates.mandateCap}, free funds ${own.candidates.freeFunds}) and ≥ the smallest ${p.minTranche}; the cost is P3's` : \"no tranche is due (P1), so there is no tranche to compare the request with\");\n", 1);
  swap('    add("T2", "Quoted rate close to the venues\' depth-weighted mid (manipulation screen)", deviation <= TRADE_POLICY.maxRateDeviationBps,',
    '    // D-K4a: computed only when T1 passes: without a route that executes there is no quoted rate to screen, and T1 says so\n    if (own.sim.ok && own.sim.amountOut > 0n) add("T2", "Quoted rate close to the venues\' depth-weighted mid (manipulation screen)", deviation <= TRADE_POLICY.maxRateDeviationBps,', 1);
  swap('    add("T3", "Order commits to the current venue set", /^0x[0-9a-f]{64}$/i.test(venueSetHash), venueSetHash);\n',
    "    // D-K4a: the venue set the order commits to is the one read and solved over: QEDExecution's keccak256(abi.encode(venues))\n" +
    "    const solvedOver = venueSetHashOf(venues);\n" +
    "    add(\"T3\", \"Order commits to the venue set the co-signer read and solved over\", solvedOver.toLowerCase() === String(venueSetHash).toLowerCase(), `the ${venues.length} venues read hash to ${solvedOver}; the module commits to ${venueSetHash}`);\n", 1);

  // ── change 6 (S5): τ covers the output token's granularity, only where the configuration asks ──
  swap("      tolerancePpm: Math.min(TRADE_POLICY.maxTolerancePpm, Math.max(TRADE_POLICY.tolerancePpm, Math.ceil(2 * own.gapPpm))),\n",
    "      // S5 (change 6): with minToleranceUnits configured, τ never asks for less than that many base units of the output\n" +
    "      tolerancePpm: this.orderTolerance(Math.min(TRADE_POLICY.maxTolerancePpm, Math.max(TRADE_POLICY.tolerancePpm, Math.ceil(2 * own.gapPpm))), own.sim.amountOut),\n", 1);

  const fmtCalls = body.split("fmt(").length - 1;
  body = body.split("fmt(").join("this.fmt(");
  if (fmtCalls < 10) throw new Error(`expected the record texts to format amounts with fmt(), found ${fmtCalls}`);

  // the helpers the two changes need, appended to the class
  const lastBrace = body.lastIndexOf("}");
  body = body.slice(0, lastBrace) + HELPERS + "}\n";
  return HEADER + body.split("\n").map((l) => (l.length ? `  ${l}` : l)).join("\n") + FOOTER;
}

const HEADER = `/**
 * GENERATED by scripts/fork-cosigner.mjs from vendor/agent/src/roles/cosigner.ts (the release's co-signer, which
 * stays unmodified). Do not edit by hand: change the script and run it again; test/cosigner-fork.test.ts checks that
 * this file is exactly the script's output and that, for an ordinary-key owner on a 6-decimal vault, the fork and the
 * release engine certify or refuse identically (with every check the same except the three change 5 redefines).
 *
 * Decision D-A (22 Nov 2026, taken by the R7 orchestrator, not by the owner; docs/r7/00-ARCHITECTURE-DECISIONS.md).
 * Two changes, nothing else:
 *   1. owner signatures (C1 mandate, C3 instruction, conversion and policy) are checked as the vault checks them:
 *      ECDSA recovery for an owner without code (exactly the release's check), ERC-1271 isValidSignature for a
 *      contract owner (a workspace's passkey account, chain/accounts);
 *   2. the reserve buffer (5 units), the earned-autonomy base (10 units) and the amounts written in records use the
 *      decimals of the vault's own asset, read from the chain.
 * Decision D-K4a (R13, F-018), for every configuration:
 *   5. each named check of a conversion can fail alone: P2 is "if a tranche is due, the request is no larger than the
 *      tranche the policy allows (shortfall, caps, free funds) and no smaller than its smallest", the cost limit being P3's
 *      alone; T2 is computed only when T1 passes; T3 recomputes the venue-set hash from the venues read and compares.
 * R7 decision D7 (docs/r7/00-ARCHITECTURE-DECISIONS.md D7; experiments/r7/S1-science/D7-authority-budget.md), only
 * when the configuration says authority "d7":
 *   3. check C12 is the authority budget (rail/authority-ledger.ts): a payment's C12 keeps its id and place; a
 *      conversion gains C12 as its last check; certificates signed and not yet used reserve their worst case; K1's caps
 *      on earned authority are the operator's, lowered by the owner's passkey-signed caps in force (D-K1b);
 *   4. a conversion's certificate expires after 15 minutes instead of 4 hours, so the worst case a reverted
 *      conversion reserved is released within minutes (experiments/r8/D7-validation, F-R8-4).
 * Money-model S5, only when the configuration sets minToleranceUnits (a workspace whose currency set is not the default):
 *   6. an order's τ never asks for less than that many base units of the output token, and never more than 1%.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { encodeAbiParameters, getAddress, hashMessage, keccak256, recoverAddress, recoverMessageAddress, toHex, type Address, type Hex, type LocalAccount } from "viem";
import type { Vendored } from "./vendored.ts";
import type { CertRequest, CertResponse, CosignerConfig, TradeRequest, TradeResponse } from "../vendor/agent/src/roles/cosigner.ts";
import type { Chain$ } from "../vendor/agent/src/chain.ts";
import type { Certificate } from "../vendor/agent/src/protocol/eip712.ts";
import type { Check } from "../vendor/agent/src/engine/economics.ts";
import type { Order } from "../vendor/agent/src/roles/trader.ts";
import type { AuthorityView } from "../types.ts";
import { bandOf, buildLedger, conversionCost, eventsFromLogs, paymentCost, price, readAuthorityLogs, units, viewOf, withOwnerCaps, type D7Config, type Grant, type Ledger, type Reservation } from "./authority-ledger.ts";

/** The engine's configuration: the release's, and the authority rule (R7 D7). Without an authority rule, or with "release", C12 is the release's. */
export type ForkCosignerConfig = CosignerConfig & { authority?: "release" | "d7"; d7?: D7Config; minToleranceUnits?: number };

const ERC1271_ABI = [{ type: "function", name: "isValidSignature", stateMutability: "view", inputs: [{ name: "hash", type: "bytes32" }, { name: "signature", type: "bytes" }], outputs: [{ name: "", type: "bytes4" }] }] as const;
const ERC20_DECIMALS_ABI = [{ type: "function", name: "decimals", stateMutability: "view", inputs: [], outputs: [{ name: "", type: "uint8" }] }] as const;
const VAULT_ASSET_ABI = [{ type: "function", name: "asset", stateMutability: "view", inputs: [], outputs: [{ name: "", type: "address" }] }] as const;
/** R7 D7 (change 4): how long a conversion's certificate, and so the reservation of its worst case, lives. */
export const D7_CONVERSION_CERTIFICATE_SECONDS = 15 * 60;
/** D-K4a (change 5): QEDExecution's venue-set hash, keccak256(abi.encode(Venue[])), recomputed from venues as read. */
export function venueSetHashOf(venues: readonly { pool: Address; token0: Address; token1: Address; feeBps: number }[]): Hex {
  return keccak256(encodeAbiParameters([{ type: "tuple[]", components: [{ name: "pool", type: "address" }, { name: "token0", type: "address" }, { name: "token1", type: "address" }, { name: "feeBps", type: "uint16" }] }], [venues.map((v) => ({ pool: v.pool, token0: v.token0, token1: v.token1, feeBps: v.feeBps }))]));
}
/**
 * D-K4a (change 5): the tranche the policy allows before its cost limit: the release's decideTranche candidates without
 * "impact", in the release's own order (the shortfall's tranche when the caps can cover it, else the caps alone).
 */
export function policyTranche(c: { need: bigint | null; policyCap: bigint; mandateCap: bigint; freeFunds: bigint }): bigint {
  return [...(c.need !== null ? [c.need] : []), c.policyCap, c.mandateCap, c.freeFunds].reduce((a, b) => (b < a ? b : a));
}

export function createForkedPolicyEngine(v: Vendored) {
  const { ProofEscrowAbi, QEDLensAbi, QEDVaultAbi, QEDExecutionAbi } = v.abi;
  const { mandateHash, signCertificate } = v.eip712;
  const { canonical, hashRecord, invoiceDigest } = v.records;
  const POLICY = v.economics.POLICY;
  const { solve } = v.execution;
  const { hashOrder, readVenues } = v.trader;
  const { decideTranche, impactBps, observeTreasury, policyMessage } = v.treasury;
  const { certificateNow } = v.clock;
  const { TRADE_POLICY, ownerInstructionMessage, ownerTradeMessage } = v.cosigner;
  void POLICY;

`;

const HELPERS = `
  // ───────────── added by the fork (S5, change 6) ─────────────
  /**
   * τ for an order: the release's, raised so that it never asks for less than cfg.minToleranceUnits base units of the
   * output token (the bound rounds up and each hop's output down), and never above QEDExecution's MAX_TOLERANCE_PPM (1%).
   * Without the setting, exactly the release's.
   */
  private orderTolerance(release: number, out: bigint): number {
    const units = this.cfg.minToleranceUnits;
    if (!units || out <= 0n) return release;
    const floor = Number((BigInt(units) * 1_000_000n + out - 1n) / out);
    return Math.min(10_000, Math.max(release, floor));
  }

  // ───────────── added by the fork (D-A) ─────────────
  private decimals: number | null = null;
  private reserveBuffer = 0n;
  private earnedBase = 0n;
  /** The release's figures in its units (5 and 10 tUSD), in the units of this vault's asset. */
  private async loadUnits(): Promise<void> {
    if (this.decimals !== null) return;
    const asset = (await this.chain.pub.readContract({ address: this.cfg.vault, abi: VAULT_ASSET_ABI, functionName: "asset" })) as Address;
    const d = Number(await this.chain.pub.readContract({ address: asset, abi: ERC20_DECIMALS_ABI, functionName: "decimals" }));
    this.decimals = d;
    this.reserveBuffer = 5n * 10n ** BigInt(d);
    this.earnedBase = 10n * 10n ** BigInt(d);
  }
  private fmt(x: bigint): string {
    return (Number(x) / 10 ** (this.decimals ?? 6)).toFixed(2);
  }
  /** OpenZeppelin SignatureChecker, as QEDVault uses it: ECDSA for an owner without code, ERC-1271 otherwise. */
  private async ownerSigned(owner: Address, hash: Hex, signature: Hex, label: string): Promise<{ ok: boolean; detail: string }> {
    const code = await this.chain.pub.getCode({ address: owner });
    if (!code || code === "0x") {
      const signer = await recoverAddress({ hash, signature }).catch(() => "0x0" as Address);
      return { ok: getAddress(signer) === getAddress(owner), detail: \`\${label} \${signer}\` };
    }
    const magic = await this.chain.pub.readContract({ address: owner, abi: ERC1271_ABI, functionName: "isValidSignature", args: [hash, signature] }).catch(() => "0x00000000");
    return { ok: String(magic).toLowerCase() === "0x1626ba7e", detail: \`ERC-1271 owner account \${getAddress(owner)} answered \${String(magic)}\` };
  }
  private async ownerSignedMessage(owner: Address, message: string, signature: Hex, label: string): Promise<{ ok: boolean; detail: string }> {
    const code = await this.chain.pub.getCode({ address: owner });
    if (!code || code === "0x") {
      const s = await recoverMessageAddress({ message, signature }).catch(() => "0x0" as Address);
      return { ok: getAddress(s) === getAddress(owner), detail: \`\${label} \${s}\` };
    }
    return this.ownerSigned(owner, hashMessage(message), signature, label);
  }

  // ───────────── added by the fork (R7 decision D7; only with authority "d7") ─────────────
  /** Grants and reservations live in the co-signer's durable state (rail/cosigner.ts), which hands them over after each configure. */
  private authorityGrants: () => Grant[] = () => [];
  private authorityHeld: Reservation[] = [];
  /** D-K1b: the owner's signed earned-authority caps in force at a moment (ms), from the co-signer's durable state. */
  private authorityCaps: (nowMs: number) => { perWindow: string | null; perPayer: string | null } = () => ({ perWindow: null, perPayer: null });
  private get authorityRule(): "release" | "d7" {
    return this.cfg.authority === "d7" ? "d7" : "release";
  }
  private d7(): D7Config {
    if (!this.cfg.d7) throw new Error('authority "d7" needs its configuration (d7): nothing was decided');
    return this.cfg.d7;
  }
  setAuthorityState(grants: () => Grant[], reservations: Reservation[], caps?: (nowMs: number) => { perWindow: string | null; perPayer: string | null }): void {
    this.authorityGrants = grants;
    this.authorityHeld = [...reservations];
    if (caps) this.authorityCaps = caps;
  }
  authorityReservations(): Reservation[] {
    return [...this.authorityHeld];
  }
  /**
   * The budget from the chain's history, the owner's grants and the certificates still outstanding. It forgets the
   * reservations that no longer reserve (used, expired, voided) by removing exactly those: one added by a certificate
   * signed while the chain was being read is never dropped.
   */
  private async authorityLedger(epoch: bigint, now: number): Promise<Ledger> {
    // D-K1b: K1's caps are the operator's, lowered by the owner's signed caps in force now (never raised by them)
    const d = withOwnerCaps(this.d7(), this.authorityCaps(now * 1000)), seen = [...this.authorityHeld];
    const { logs, latestBlock } = await readAuthorityLogs(this.chain.pub, d, { vault: QEDVaultAbi, execution: QEDExecutionAbi, escrow: ProofEscrowAbi }, this.cfg.deployBlock);
    const l = buildLedger(d, eventsFromLogs(d, logs), { latestBlock, grants: this.authorityGrants(), reservations: seen, now: BigInt(now), epoch });
    const gone = new Set(seen.filter((r) => !l.liveReservations.includes(r)));
    this.authorityHeld = this.authorityHeld.filter((r) => !gone.has(r));
    return l;
  }
  /** The budget as a read, for the rail's payment preview: nothing is signed or reserved. */
  async authorityView(): Promise<AuthorityView> {
    await this.loadUnits();
    const pub = this.chain.pub;
    const block = await pub.getBlock();
    const now = certificateNow(Number(block.timestamp), this.chain.chainId);
    const snap = (await pub.readContract({ address: this.cfg.lens, abi: QEDLensAbi, functionName: "snapshot", args: [this.cfg.vault] })) as any;
    return viewOf(this.d7(), await this.authorityLedger(BigInt(snap.epoch), now));
  }
  private reserveAuthority(certificate: Certificate, hold: { cost: bigint; kind: Reservation["kind"] }): void {
    this.authorityHeld.push({ intentId: certificate.intentId, cost: hold.cost.toString(), kind: hold.kind, expiresAt: certificate.expiresAt.toString(), epoch: certificate.epoch.toString(), at: new Date().toISOString() });
  }
  /** C12 of an owner-instructed payment: what it takes out of the workspace's control must fit in what is available. */
  private async authorityForPayment(snap: any, payee: Address, amount: bigint, forward: boolean, now: number) {
    const d = this.d7(), S = d.symbol, u = (x: bigint) => units(x, d.decimals);
    const l = await this.authorityLedger(BigInt(snap.epoch), now);
    const { cost, how } = paymentCost(d, payee, amount, forward);
    const what = how === "self-payment"
      ? \`\${u(amount)} \${S} to \${payee}, an account of the workspace itself: nothing leaves its control, so it uses nothing\`
      : how === "hold"
        ? \`a promise of \${u(amount)} \${S} to \${payee}: set aside from now until it is paid or released, so it needs \${u(cost)} \${S} available\`
        : \`\${u(amount)} \${S} to \${payee}, outside the workspace: it uses \${u(cost)} \${S}\`;
    const kind: Reservation["kind"] = forward ? "hold" : "payment";
    return { name: "Authority budget (R7 D7): what this payment takes out of the workspace's control fits in what the owner granted and the workspace earned", pass: cost <= l.available, detail: \`\${what}; \${viewOf(d, l).statement}\`, hold: cost > 0n ? { cost, kind } : null };
  }
  /** C12 of a conversion: its worst case against the reference (the order's floor at the band's low end) must fit in what is available. */
  private async authorityForTrade(snap: any, req: TradeRequest, order: Order, marketOutPerIn: number, now: number) {
    const d = this.d7(), S = d.symbol, u = (x: bigint) => units(x, d.decimals);
    const l = await this.authorityLedger(BigInt(snap.epoch), now);
    const c = conversionCost(d, { tokenIn: req.tokenIn, amountIn: req.amountIn, tokenOut: req.tokenOut, minOut: order.minOut, recipient: req.recipient, marketOutPerIn });
    const name = "Authority budget (R7 D7): this conversion's cost against the reference fits in what the owner granted and the workspace earned";
    const statement = viewOf(d, l).statement;
    const kind: Reservation["kind"] = "conversion";
    const hold = c.cost > 0n ? { cost: c.cost, kind } : null;
    if (c.how === "convert-and-pay") return { name, pass: c.cost <= l.available, detail: \`the output goes to \${req.recipient}, outside the workspace, so the conversion is a payment of its input: it uses \${u(c.cost)} \${S}; \${statement}\`, hold };
    if (c.how === "unvalued-input") return { name, pass: false, detail: \`\${req.tokenIn} has no reference band, so what this conversion gives cannot be valued at the top of one: it is refused; \${statement}\`, hold: null };
    if (c.how === "unvalued" || !c.ref) return { name, pass: c.cost <= l.available, detail: \`\${req.tokenOut} has no reference band, so what the conversion receives is worth nothing to the budget and it uses its whole input, \${u(c.cost)} \${S}; \${statement}\`, hold };
    const r = c.ref, b = bandOf(d, req.tokenOut).band, R = r.symbol;
    const ref = \`the reference band \${price(b.lo, r, d)} to \${price(b.hi, r, d)} \${S} per \${R} (\${r.source})\`;
    const mid = c.market === null ? "no direct venue" : \`\${(c.market * 10 ** (r.decimals - d.decimals)).toFixed(2)} \${S} per \${R}\`;
    if (!c.inside) return { name, pass: false, detail: \`the venues' depth-weighted mid is \${mid}, outside \${ref}\${r.divergenceBps ? \` widened by \${r.divergenceBps / 100}%\` : ""}: the reference does not describe the market now, so the conversion cannot be valued and is refused; \${statement}\`, hold: null };
    return { name, pass: c.cost <= l.available, detail: \`\${u(req.amountIn)} \${S} into \${R} for \${req.recipient}, an account of the workspace, uses only its cost against the reference: what is given less what is received, valued at the band's low end. At the order's floor of \${units(order.minOut, r.decimals)} \${R} and \${price(b.lo, r, d)} \${S} per \${R} (\${ref}; the venues' mid now \${mid}) it can cost at most \${u(c.cost)} \${S}, reserved until the conversion executes, when its realised cost is counted instead; \${statement}\`, hold };
  }
`;

const FOOTER = `
  return ForkedPolicyEngine;
}
export type ForkedPolicyEngine = InstanceType<ReturnType<typeof createForkedPolicyEngine>>;
`;

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const out = generate();
  if (process.argv.includes("--check")) {
    const now = readFileSync(TARGET, "utf8");
    if (now !== out) { console.error("rail/cosigner-engine.ts is not what scripts/fork-cosigner.mjs generates. Run it again."); process.exit(1); }
    console.log("rail/cosigner-engine.ts is exactly the generator's output.");
  } else {
    writeFileSync(TARGET, out);
    console.log(`wrote ${TARGET}`);
  }
}
