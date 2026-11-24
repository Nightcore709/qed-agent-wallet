/**
 * Earning on the chain (R7-054): the release's ProofEscrow and MinVarianceVerifier, unmodified and shared by every
 * workspace on this host (deploy.ts, deployMarket). Two workspaces complete one job:
 *
 *   escrow-quote    PROVIDER. Its owner account signs an EIP-712 Quote through ERC-1271: its passkey signs the account's
 *                   replay-safe hash of the escrow's own quote digest. The quote binds the price, the payee (the
 *                   provider's treasury vault), the client (the client workspace's owner account), tINR, the shared
 *                   verifier, the problem's hash, the delivery deadline and how long the offer stands. No money moves.
 *   escrow-fund     CLIENT. Its owner account, in ONE execute signed by its passkeys: withdraw the price from its own
 *                   treasury vault (free funds only), approve the escrow for exactly the price, open the job with the
 *                   provider's signed quote. Atomic: if the escrow refuses, nothing leaves the vault.
 *   escrow-deliver  PROVIDER. Its owner account delivers the problem and a certificate: by default the release's
 *                   certifying solver computes it, or the caller supplies one. Checked first with escrow.check (the
 *                   verifier, no state change); the escrow pays the payee in the same transaction or reverts.
 *   escrow-release  PROVIDER, before the deadline: refunds the client (ProofEscrow.refund by the provider).
 *   escrow-refund   ANYONE, after the deadline: refunds an open job to its client. The rail's relayer; no approval.
 *
 * The escrow has no reviewer, oracle or dispute step: a certificate the verifier accepts settles, and a job without
 * one by its deadline goes back to its client.
 *
 * With a dispute step (R13, audit item E3), the quote names QED's dispute escrow (chain/disputes, rail/disputes.ts) as
 * its client and payee, and its quoteId is the hash of the dispute terms: the provider's one signature binds the price,
 * the work, the deadline, the named decider, the three periods and both timeout outcomes. Then:
 *   escrow-fund     the client's owner account opens the job through the dispute escrow (withdraw, approve, open);
 *   escrow-deliver  ProofEscrow.deliver and QEDDisputeEscrow.noteDelivered in one execute: the verifier's acceptance
 *                   pays the dispute escrow, and the client's review starts in the same block;
 *   escrow-accept   CLIENT: the provider is paid in full at once;
 *   escrow-dispute  CLIENT, within the review: with a reason, kept by QED, its keccak256 on the chain;
 *   escrow-evidence CLIENT or PROVIDER, within the evidence period: a text, its keccak256 on the chain;
 *   escrow-decide   the NAMED DECIDER, after the evidence period and by the decision deadline, within its powers;
 *   escrow-give-way PROVIDER: the client is refunded in full;
 *   escrow-finish   ANYONE, once a period has run out: the timeout outcome of the terms (the rail's relayer);
 *   escrow-release / escrow-refund  as above, the refund reaching the client through the dispute escrow.
 * The chain enforces who may act, when, and where the money may go (QEDDisputeEscrow.sol). QED checks before anything is
 * signed that the decider is a third workspace of this installation, keeps the texts, and shows every period, outcome
 * and power before the provider signs and before the client funds. A payment through the dispute escrow adds nothing
 * to the authority budget: R7 D7 counts only the proof escrow's own settlements into the vault. "Verified" means the delivered portfolio is certified optimal for the
 * quoted problem within its tolerance; not that the problem was worth its price. R7 D7: a settlement to this
 * workspace's vault adds ⌊price/2⌋ to the authority budget only when its client is outside the principal set, it was
 * paid in tINR, and it has two confirmations (authority-ledger.ts); escrowJobs() says which, for each job.
 */
import { decodeAbiParameters, encodeAbiParameters, encodeFunctionData, getAddress, keccak256, parseEventLogs, toHex, type Address, type Hex } from "viem";
import type { DisputeJobView, EscrowJobView, EscrowQuote, OpResult, ProposalKind } from "../types.ts";
import { buildLedger, earnedCapWords, eventsFromLogs, readAuthorityLogs, units, withOwnerCaps } from "./authority-ledger.ts";
import { CHAIN_ID } from "./config.ts";
import { DISPUTE, DISPUTE_OUTCOME, DISPUTE_STATUS } from "./disputes.ts";
import type { OwnerAction } from "./keys.ts";
import type { PasskeyAccountOwner } from "./owner.ts";
import { RailError, type Ctx, type RailService } from "./service.ts";

const WAD = 10n ** 18n;
const TOLERANCE = 10n ** 9n; // τ = 1e-9 in WAD, the release's own tolerance for the Helix problem
const STATUS = ["none", "open", "settled", "refunded"] as const;
const HEX32 = /^0x[0-9a-fA-F]{64}$/, ADDR = /^0x[0-9a-fA-F]{40}$/, UINT = /^\d{1,30}$/;
const bad = (m: string) => new RailError("invalid_params", m, 422);
const isZero = (a: string) => /^0x0+$/.test(a);

/** The problems a quote may name. Synthetic test data: neither is market data or advice. */
export interface Problem { kind: "helix" | "custom"; title: string; assets: { name: string; volatilityBps: number }[]; correlations: "helix" | "zero"; n: number; tolerance: string; universe: Hex; note: string }

export function installEscrow(rail: RailService) {
  const owner = () => {
    if (rail.owner.kind !== "passkey-account" || !rail.host.market) throw new RailError("unsupported_proposal", "Earning through the proof escrow needs a workspace owned by a passkey account on the multi-tenant rail.", 422);
    return rail.owner as PasskeyAccountOwner;
  };
  const E = () => rail.host.market!.escrow, VER = () => rail.host.market!.verifier;
  const A = () => rail.v.abi;
  const readE = (fn: string, args: unknown[] = []) => rail.read(E(), A().ProofEscrowAbi, fn, args);
  // ───────────── the dispute escrow in front of the proof escrow (R13 E3) ─────────────
  const D = () => rail.host.disputes;
  const needD = () => { const d = D(); if (!d) throw new RailError("disputes_unavailable", `Work with a dispute step needs the dispute escrow, which this rail does not have: ${rail.host.disputeStatus.reason ?? "not started"}. Nothing was prepared.`, 503); return d; };
  const readD = (fn: string, args: unknown[] = []) => { const d = needD(); return rail.read(d.address, d.abi, fn, args); };
  const viaDispute = (a: string) => { const d = D(); return !!d && getAddress(a) === getAddress(d.address); };
  /** The dispute terms as QEDDisputeEscrow.Terms holds them: periods in seconds, shares in basis points of the price. */
  interface Arb { client: Address; payee: Address; decider: Address; deciderMay: number; reviewPeriod: number; evidencePeriod: number; decisionPeriod: number; reviewTimeoutBps: number; decisionTimeoutBps: number; salt: Hex }
  const ARB_KEYS = ["client", "payee", "decider", "deciderMay", "reviewPeriod", "evidencePeriod", "decisionPeriod", "reviewTimeoutBps", "decisionTimeoutBps", "salt"];
  const arbIn = (a: Arb) => ({ client: a.client, payee: a.payee, decider: a.decider, deciderMay: a.deciderMay, reviewPeriod: a.reviewPeriod, evidencePeriod: a.evidencePeriod, decisionPeriod: a.decisionPeriod, reviewTimeoutBps: a.reviewTimeoutBps, decisionTimeoutBps: a.decisionTimeoutBps, salt: a.salt });
  const arbOut = arbIn;
  const pctOf = (bps: number) => `${(bps / 100).toFixed(bps % 100 ? 2 : 0)}%`;
  const span = (x: number) => (x % 86_400 === 0 ? `${x / 86_400} day${x === 86_400 ? "" : "s"}` : x % 3600 === 0 ? `${x / 3600} hour${x === 3600 ? "" : "s"}` : `${x} seconds`);
  const powers = (mask: number) => [mask & DISPUTE.MAY_PAY_PROVIDER ? "pay the provider in full" : "", mask & DISPUTE.MAY_REFUND_CLIENT ? "refund the client in full" : "", mask & DISPUTE.MAY_SPLIT ? "split the price between them" : ""].filter(Boolean);
  /** The terms in plain sentences, for the documents both sides sign. */
  const arbWords = (a: Arb, price: bigint) => {
    const [p1, c1] = splitOf(price, a.reviewTimeoutBps), [p2, c2] = splitOf(price, a.decisionTimeoutBps);
    return [
      `Review: the client has ${span(a.reviewPeriod)} from the verified delivery to accept the work or dispute it. If the review ends with no answer, ${fmt(p1)} ${S()} (${pctOf(a.reviewTimeoutBps)}) goes to the provider and ${fmt(c1)} ${S()} to the client.`,
      `Evidence: after a dispute, both sides have ${span(a.evidencePeriod)} to add evidence. Only its hash goes on the chain; QED keeps the text.`,
      `Decision: the named decider rules after the evidence period and at the latest ${span(a.decisionPeriod)} after the dispute. It may ${powers(a.deciderMay).join(", or ")}. It is paid nothing and cannot send the money anywhere else.`,
      `If no ruling comes in time, ${fmt(p2)} ${S()} (${pctOf(a.decisionTimeoutBps)}) goes to the provider and ${fmt(c2)} ${S()} to the client. In any split the client's part is rounded down and the provider receives the rest.`,
      "Either side may still give way at any time before the end: the client by accepting the work, the provider by refunding the client. Anyone may apply a timeout once it has passed.",
    ];
  };
  /** A split as the contract computes it: the client's part rounded down, the provider the rest. */
  const splitOf = (price: bigint, bps: number): [bigint, bigint] => { const c = (price * BigInt(DISPUTE.BPS - bps)) / BigInt(DISPUTE.BPS); return [price - c, c]; };
  /** The provider's choice of dispute terms, checked against the contract's bounds; the salt makes the commitment unique. */
  function disputeTermsFor(raw: unknown, client: Address, provider: Address): Arb {
    needD();
    const d = raw as Record<string, unknown> | null;
    const keys = ["decider", "reviewSeconds", "evidenceSeconds", "decisionSeconds", "onReviewBps", "onDecisionBps", "deciderMay"];
    if (!d || typeof d !== "object" || Object.keys(d).some((k) => !keys.includes(k)) || keys.some((k) => !(k in d))) throw bad(`dispute is { ${keys.join(", ")} }.`);
    if (typeof d.decider !== "string" || !ADDR.test(d.decider)) throw bad("dispute.decider is the deciding workspace's owner account address.");
    const decider = getAddress(d.decider);
    if (decider === client || decider === provider || decider === getAddress(rail.a.vault)) throw new RailError("decider_not_independent", "The decider must be a third party, neither the client nor the provider. Nothing was prepared.", 422);
    if (!workspaceOf(decider)) throw new RailError("unknown_decider", "The decider is not a workspace of this installation. QED names as decider only another workspace here, owned by its own passkeys. Nothing was prepared.", 422);
    const secs = (k: string) => { const v = d[k]; if (!Number.isInteger(v) || (v as number) < DISPUTE.MIN_PERIOD || (v as number) > DISPUTE.MAX_PERIOD) throw bad(`dispute.${k} is a whole number of seconds from ${DISPUTE.MIN_PERIOD} to ${DISPUTE.MAX_PERIOD}.`); return v as number; };
    const reviewPeriod = secs("reviewSeconds"), evidencePeriod = secs("evidenceSeconds"), decisionPeriod = secs("decisionSeconds");
    if (evidencePeriod > DISPUTE.MAX_PERIOD - DISPUTE.MIN_PERIOD || decisionPeriod < evidencePeriod + DISPUTE.MIN_PERIOD) throw bad("dispute.decisionSeconds ends at least a minute after the evidence period: the decider rules once the evidence is in.");
    const bps = (k: string) => { const v = d[k]; if (!Number.isInteger(v) || (v as number) < 0 || (v as number) > DISPUTE.BPS) throw bad(`dispute.${k} is the provider's share in basis points, 0 to 10000.`); return v as number; };
    const may = d.deciderMay as Record<string, unknown> | null;
    if (!may || typeof may !== "object" || Object.keys(may).some((k) => !["pay", "refund", "split"].includes(k)) || Object.values(may).some((v) => typeof v !== "boolean")) throw bad("dispute.deciderMay is { pay, refund, split }, each true or false.");
    const mask = (may.pay ? DISPUTE.MAY_PAY_PROVIDER : 0) | (may.refund ? DISPUTE.MAY_REFUND_CLIENT : 0) | (may.split ? DISPUTE.MAY_SPLIT : 0);
    if (!mask) throw bad("The decider needs at least one power: pay the provider, refund the client or split.");
    return { client, payee: getAddress(rail.a.vault), decider, deciderMay: mask, reviewPeriod, evidencePeriod, decisionPeriod, reviewTimeoutBps: bps("onReviewBps"), decisionTimeoutBps: bps("onDecisionBps"), salt: keccak256(toHex(`qed-dispute/${rail.genesisId}/${rail.id}/${rail.store.next("dispute-terms")}`)).toLowerCase() as Hex };
  }
  /** Signed dispute terms as the client sends them back with the quote. */
  function parseArb(raw: unknown): Arb {
    const a = raw as Record<string, unknown> | null;
    if (!a || typeof a !== "object" || Object.keys(a).length !== ARB_KEYS.length || ARB_KEYS.some((k) => !(k in a))) throw bad(`dispute is the provider's dispute terms: { ${ARB_KEYS.join(", ")} }.`);
    for (const k of ["client", "payee", "decider"]) if (typeof a[k] !== "string" || !ADDR.test(a[k] as string)) throw bad(`dispute.${k} is an address.`);
    for (const k of ["deciderMay", "reviewPeriod", "evidencePeriod", "decisionPeriod", "reviewTimeoutBps", "decisionTimeoutBps"]) if (!Number.isInteger(Number(a[k])) || Number(a[k]) < 0 || Number(a[k]) > 2 ** 32 - 1) throw bad(`dispute.${k} is a whole number.`);
    if (typeof a.salt !== "string" || !HEX32.test(a.salt)) throw bad("dispute.salt is 0x followed by 64 hexadecimal characters.");
    return { client: getAddress(a.client as string), payee: getAddress(a.payee as string), decider: getAddress(a.decider as string), deciderMay: Number(a.deciderMay), reviewPeriod: Number(a.reviewPeriod), evidencePeriod: Number(a.evidencePeriod), decisionPeriod: Number(a.decisionPeriod), reviewTimeoutBps: Number(a.reviewTimeoutBps), decisionTimeoutBps: Number(a.decisionTimeoutBps), salt: (a.salt as string).toLowerCase() as Hex };
  }

  const S = () => rail.asset.symbol, fmt = (x: bigint | string) => rail.fmt(x);
  const action = (to: Address, contract: string, fn: string, args: unknown[]): OwnerAction => ({ to, contract, function: fn, args });

  // ───────────── the work: a long-only minimum-variance portfolio, certified on chain ─────────────
  /** The problem from its description, as the verifier reads it (spec = abi.encode(n, cov, tol, universe)). Exact integers. */
  function problemOf(raw: unknown): { problem: Problem; spec: { n: number; cov: bigint[]; tol: bigint; universe: Hex }; specBytes: Hex } {
    const p = raw as Record<string, unknown> | null;
    const M = rail.v.riskModel;
    if (!p || typeof p !== "object" || (p.kind !== "helix" && p.kind !== "custom")) throw bad("problem is { kind: \"helix\" } (the release's illustrative six-asset risk model) or { kind: \"custom\", assets: [{ name, volatilityBps }] } (2 to 6 assets, zero correlations).");
    if (p.kind === "helix") {
      if (Object.keys(p).some((k) => k !== "kind")) throw bad("A helix problem takes { kind: \"helix\" } only.");
      const spec = M.helixSpec(TOLERANCE) as { n: number; cov: bigint[]; tol: bigint; universe: Hex };
      const problem: Problem = { kind: "helix", title: "Minimum-variance long-only portfolio on the Helix model (Oct 2026)", assets: M.HELIX_ASSETS.map((name: string, i: number) => ({ name, volatilityBps: Math.round(M.HELIX_VOLS[i] * 10_000) })), correlations: "helix", n: spec.n, tolerance: "1e-9", universe: spec.universe, note: "The Helix model is the release's ILLUSTRATIVE covariance model: synthetic volatilities and correlations, not market data and not advice." };
      return { problem, spec, specBytes: M.encodeSpec(spec) as Hex };
    }
    if (Object.keys(p).some((k) => k !== "kind" && k !== "assets")) throw bad("A custom problem takes { kind: \"custom\", assets } only.");
    const assets = p.assets;
    if (!Array.isArray(assets) || assets.length < 2 || assets.length > 6) throw bad("A custom problem names 2 to 6 assets.");
    const list = assets.map((a, i) => {
      const o = a as Record<string, unknown>;
      const name = typeof o?.name === "string" ? o.name.replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, 40) : "";
      const v = o?.volatilityBps;
      if (name.length < 1 || !Number.isInteger(v) || (v as number) < 100 || (v as number) > 10_000) throw bad(`assets[${i}] is { name, volatilityBps }: a name and an annual volatility from 100 (1%) to 10000 (100%) basis points.`);
      return { name, volatilityBps: v as number };
    });
    if (new Set(list.map((a) => a.name.toLowerCase())).size !== list.length) throw bad("Every asset of a problem needs its own name.");
    const n = list.length;
    // variance in WAD exactly: (bps / 10^4)^2 · 10^18 = bps^2 · 10^10; zero correlations, so off-diagonal entries are 0
    const cov = Array.from({ length: n * n }, (_, k) => (Math.floor(k / n) === k % n ? BigInt(list[k % n]!.volatilityBps) ** 2n * 10n ** 10n : 0n));
    const universe = keccak256(toHex(`qed-earn/custom/v1/${list.map((a) => `${a.name}:${a.volatilityBps}`).join("|")}`));
    const spec = { n, cov, tol: TOLERANCE, universe };
    const problem: Problem = { kind: "custom", title: `Minimum-variance long-only portfolio of ${n} assets`, assets: list, correlations: "zero", n, tolerance: "1e-9", universe, note: "Annual volatilities as given, correlations zero: synthetic inputs chosen by the parties, not market data and not advice." };
    return { problem, spec, specBytes: M.encodeSpec(spec) as Hex };
  }
  /** A certificate for the problem (the release's certifying solver), with the release's bit-exact check of it. */
  function certificate(spec: { n: number; cov: bigint[]; tol: bigint; universe: Hex }) {
    const sol = rail.v.minvar.certify(spec);
    return { sol, bytes: rail.v.riskModel.encodeSolution(sol) as Hex, report: rail.v.minvar.checkCertificate(spec, sol) };
  }
  const pct = (w: bigint) => { const bp = (w * 1_000_000n + WAD / 2n) / WAD; return `${bp / 10_000n}.${(bp % 10_000n).toString().padStart(4, "0")}%`; };

  // ───────────── quotes, as the escrow sees them ─────────────
  const quoteOut = (q: Record<string, unknown>): EscrowQuote => ({ provider: getAddress(q.provider as string), payee: getAddress(q.payee as string), client: getAddress(q.client as string), token: getAddress(q.token as string), price: String(q.price), verifier: getAddress(q.verifier as string), specHash: String(q.specHash).toLowerCase() as Hex, deliverBy: String(q.deliverBy), validUntil: String(q.validUntil), quoteId: String(q.quoteId).toLowerCase() as Hex });
  const quoteIn = (q: EscrowQuote) => ({ provider: q.provider, payee: q.payee, client: q.client, token: q.token, price: BigInt(q.price), verifier: q.verifier, specHash: q.specHash, deliverBy: BigInt(q.deliverBy), validUntil: BigInt(q.validUntil), quoteId: q.quoteId });
  function parseQuote(raw: unknown): EscrowQuote {
    const q = raw as Record<string, unknown> | null;
    const keys = ["provider", "payee", "client", "token", "price", "verifier", "specHash", "deliverBy", "validUntil", "quoteId"];
    if (!q || typeof q !== "object" || Object.keys(q).length !== keys.length || keys.some((k) => !(k in q))) throw bad(`quote is the provider's signed quote: { ${keys.join(", ")} }.`);
    for (const k of ["provider", "payee", "client", "token", "verifier"]) if (typeof q[k] !== "string" || !ADDR.test(q[k] as string)) throw bad(`quote.${k} is an address.`);
    for (const k of ["price", "deliverBy", "validUntil"]) if (typeof q[k] !== "string" || !UINT.test(q[k] as string)) throw bad(`quote.${k} is a whole number as a decimal string.`);
    for (const k of ["specHash", "quoteId"]) if (typeof q[k] !== "string" || !HEX32.test(q[k] as string)) throw bad(`quote.${k} is 0x followed by 64 hexadecimal characters.`);
    return quoteOut(q);
  }
  /** Which workspace of this host an owner account belongs to (escrow jobs here are between this installation's workspaces). */
  const workspaceOf = (accountAddr: Address) => rail.host.all().find((w) => w.a?.ownerAccount && getAddress(w.a.ownerAccount) === getAddress(accountAddr));
  const providerSignatureValid = async (q: EscrowQuote, sig: Hex) => {
    const digest = (await readE("quoteDigest", [quoteIn(q)])) as Hex;
    try { return ((await rail.read(q.provider, (workspaceOf(q.provider)!.owner as PasskeyAccountOwner).abi, "isValidSignature", [digest, sig])) as string).toLowerCase() === "0x1626ba7e"; } catch { return false; }
  };

  // ───────────── PROVIDER: quote ─────────────
  rail.proposers.set("escrow-quote", async (p) => {
    const o = owner();
    if (Object.keys(p).some((k) => !["client", "price", "deliverWithinHours", "validForMinutes", "problem", "title", "dispute"].includes(k))) throw bad("escrow-quote takes { client, price, deliverWithinHours, validForMinutes?, problem, title?, dispute? }.");
    if (typeof p.client !== "string" || !ADDR.test(p.client)) throw bad("client is the client workspace's owner account address.");
    const client = getAddress(p.client);
    if (client === o.address) throw new RailError("self_dealing", "A workspace cannot hire itself: the client must be another workspace's owner account. Nothing was prepared.", 422);
    if (!workspaceOf(client)) throw new RailError("unknown_client", "The client is not a workspace of this installation. QED's escrow jobs are between this installation's workspaces, each owned by its own passkeys. Nothing was prepared.", 422);
    const price = rail.raw(p.price, "Price");
    if (price <= 0n || price > 10n ** 9n) throw new RailError("invalid_amount", `A price is more than 0 and at most ${fmt(10n ** 9n)} ${S()}.`, 422);
    const hours = p.deliverWithinHours, minutes = p.validForMinutes === undefined ? 24 * 60 : p.validForMinutes;
    if (!Number.isInteger(hours) || (hours as number) < 1 || (hours as number) > 24 * 14) throw bad("deliverWithinHours is a whole number of hours from 1 to 336 (two weeks).");
    if (!Number.isInteger(minutes) || (minutes as number) < 15 || (minutes as number) > 7 * 24 * 60 || (minutes as number) >= (hours as number) * 60) throw bad("validForMinutes is a whole number of minutes from 15 to 10080 (a week), and shorter than the delivery time.");
    const { problem, spec, specBytes } = problemOf(p.problem);
    const cert = certificate(spec);
    if (!cert.report.ok) throw new RailError("unsolvable", `The release's solver could not certify this problem (${cert.report.violations.join("; ")}). Nothing was prepared.`, 422);
    const title = typeof p.title === "string" ? p.title.replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, 80) : problem.title;
    const now = await rail.chainNow();
    // with a dispute step the quote names the dispute escrow as its client and payee, and its quoteId commits to the terms
    const arb = p.dispute === undefined ? null : disputeTermsFor(p.dispute, client, o.address);
    const arbHash = arb ? ((await readD("termsHash", [arbIn(arb)])) as Hex).toLowerCase() as Hex : null;
    const via = arb ? getAddress(needD().address) : null;
    const quote: EscrowQuote = { provider: o.address, payee: via ?? getAddress(rail.a.vault), client: via ?? client, token: getAddress(rail.a.asset!), price: price.toString(), verifier: getAddress(VER()), specHash: keccak256(specBytes).toLowerCase() as Hex, deliverBy: (now + BigInt(hours as number) * 3600n).toString(), validUntil: (now + BigInt(minutes as number) * 60n).toString(), quoteId: arbHash ?? (keccak256(toHex(`qed-earn/${rail.genesisId}/${rail.id}/${rail.store.next("escrow-quote")}`)).toLowerCase() as Hex) };
    const digest = (await readE("quoteDigest", [quoteIn(quote)])) as Hex;
    const local = rail.v.eip712.quoteDigest(CHAIN_ID, E(), quoteIn(quote) as never);
    if (local.toLowerCase() !== digest.toLowerCase()) throw new RailError("quote_digest_mismatch", "The escrow's quote digest differs from the release's own computation of it. Nothing was prepared.", 500);
    const quoteHash = ((await readE("hashQuote", [quoteIn(quote)])) as Hex).toLowerCase();
    const terms = {
      kind: "escrow-quote", chainId: CHAIN_ID, genesisId: rail.genesisId, escrow: getAddress(E()), verifier: { address: getAddress(VER()), problemClass: "markowitz.min-variance.long-only/v1" },
      title, quote, quoteHash, problem, spec: specBytes, price: rail.fmt(price).replace(/,/g, ""), priceRaw: price.toString(),
      deliverByTime: new Date(Number(quote.deliverBy) * 1000).toISOString(), validUntilTime: new Date(Number(quote.validUntil) * 1000).toISOString(),
      erc1271: { purpose: "quote", hash: digest },
      dispute: arb ? { escrow: via, client, terms: arbOut(arb), termsHash: arbHash, words: arbWords(arb, price) } : null,
      effect: arb
        ? `Offers this work to the client's owner account ${client.slice(0, 10)}… for ${fmt(price)} ${S()}, under the dispute terms below. When a certificate the verifier accepts arrives by ${new Date(Number(quote.deliverBy) * 1000).toISOString()}, the proof escrow pays the dispute escrow, which holds the money for the client's review; it reaches this workspace's treasury vault when the client accepts, when the review ends without an answer (${pctOf(arb.reviewTimeoutBps)} to this vault), or as the decider rules on a dispute. The quote's id is the hash of those terms, so this one signature binds them too. Signing moves no money and sends no transaction. If no valid certificate arrives in time, the client gets the money back.`
        : `Offers this work to the client's owner account ${client.slice(0, 10)}… for ${fmt(price)} ${S()}, paid by the proof escrow to this workspace's treasury vault when a certificate the verifier accepts arrives by ${new Date(Number(quote.deliverBy) * 1000).toISOString()}. The client may fund it until ${new Date(Number(quote.validUntil) * 1000).toISOString()}. Signing moves no money and sends no transaction. If no valid certificate arrives in time, the client gets the money back.`,
      authority: arb ? "Paid through the dispute escrow, this work adds nothing to the agent's authority budget: R7 D7 counts only the proof escrow's own settlements into this vault." : "When the job settles into this vault from a client outside this workspace, half its price adds to the agent's authority budget after two confirmations (R7 D7). From a client this workspace shares a member or a key with, it adds nothing.",
    };
    return { terms, summary: `Offer "${title}" to ${client.slice(0, 10)}… for ${fmt(price)} ${S()}, delivery within ${hours} hour${hours === 1 ? "" : "s"}. No money moves.`, allowed: true, checks: [], replaces: [] as ProposalKind[] };
  });
  rail.handlers.set("escrow-quote", async (ctx): Promise<OpResult> => {
    const t = ctx.terms, o = owner();
    const { signature } = await o.signHash(t, ctx.approval, ctx.window);
    if (!(await providerSignatureValid(t.quote, signature))) throw new RailError("quote_signature_invalid", "The owner account did not accept the passkey signature for the escrow's quote digest. Nothing was signed.", 409);
    rail.store.setMeta(`escrow:quote:${t.quoteHash}`, { quote: t.quote, signature, spec: t.spec, problem: t.problem, title: t.title, at: rail.iso(), jobId: ctx.jobId, dispute: t.dispute ?? null });
    rail.store.appendDecision({ at: rail.iso(), kind: "escrow-quote", jobId: ctx.jobId, verdict: "SIGNED", clock: ctx.clock ?? (await rail.clock()), approval: ctx.approval, termsHash: ctx.proposal!.termsHash, record: { quote: t.quote, quoteHash: t.quoteHash } });
    ctx.push({ key: "owner", label: "Provider signs the quote", status: "ok", detail: `Approval ${ctx.approval!.approvalId} binds these exact terms. The passkey signed the owner account's replay-safe hash of the escrow's quote digest (ERC-1271), and the account accepts it on chain: the escrow will check exactly this when the client funds the job. Nothing was sent.`, data: { quoteHash: t.quoteHash } });
    const summary = `Signed the quote "${t.title}" for ${fmt(t.priceRaw)} ${S()} to ${String(t.quote.client).slice(0, 10)}…; the client may fund it until ${t.validUntilTime}. No money moved.`;
    rail.record(ctx, { kind: "escrow", title: summary, outcome: "executed" });
    return { outcome: "executed", summary, evidence: { quote: t.quote, quoteHash: t.quoteHash, signature, spec: t.spec, problem: t.problem, ...(t.dispute ? { dispute: t.dispute } : {}) } };
  });
  rail.rerunnable.add("escrow-quote");

  // ───────────── CLIENT: fund from its own vault ─────────────
  rail.proposers.set("escrow-fund", async (p) => {
    const o = owner();
    // R13: funding takes the price out of the vault with withdraw in the same transaction; time-locked, withdraw waits
    // the account's delay, so the batch could not open the job. Refused with the reason rather than half-scheduled.
    if (rail.owner.kind === "passkey-account" && (await (rail.owner as PasskeyAccountOwner).timeLockOn())) throw new RailError("time_locked", "This wallet's time-lock is on, so money leaves the vault only after the account's delay: a job cannot be funded from it in one step. Turn the time-lock off (that waits the delay too) to fund jobs from the vault. Nothing was prepared.", 409);
    if (Object.keys(p).some((k) => !["quote", "signature", "spec", "dispute"].includes(k))) throw bad("escrow-fund takes { quote, signature, spec?, dispute? }.");
    const q = parseQuote(p.quote);
    if (typeof p.signature !== "string" || !/^0x([0-9a-fA-F]{2}){64,8000}$/.test(p.signature)) throw bad("signature is the provider's signature of the quote (hex).");
    const sig = p.signature as Hex;
    // through the dispute escrow: the quote names it as client and payee, and the terms name the client and the provider's vault
    const arb = viaDispute(q.client) ? parseArb(p.dispute) : null;
    if (!arb && p.dispute !== undefined) throw bad("This quote has no dispute step: its client is not the dispute escrow.");
    if (arb) {
      const d = needD();
      if (arb.client !== o.address) throw new RailError("not_the_client", "These dispute terms name another client: only the owner account they name may fund this job. Nothing was prepared.", 409);
      if (q.payee !== getAddress(d.address)) throw new RailError("quote_not_for_dispute_escrow", "With a dispute step the proof escrow must pay the dispute escrow, not the provider directly. Nothing was prepared.", 422);
      const th = ((await readD("termsHash", [arbIn(arb)])) as Hex).toLowerCase();
      if (th !== q.quoteId) throw new RailError("terms_mismatch", "These dispute terms are not the ones the provider signed: the quote's id is the hash of the terms it accepted. Nothing was prepared.", 409);
      if (arb.decider === o.address || arb.decider === q.provider || !workspaceOf(arb.decider)) throw new RailError("decider_not_independent", "The decider must be a third workspace of this installation, neither party. Nothing was prepared.", 422);
    } else if (q.client !== o.address) throw new RailError("not_the_client", "This quote is offered to another client: only the owner account it names may fund it. Nothing was prepared.", 409);
    if (q.provider === o.address) throw new RailError("self_dealing", "A workspace cannot hire itself. Nothing was prepared.", 422);
    if (q.token !== getAddress(rail.a.asset!)) throw new RailError("wrong_token", `This quote is priced in ${q.token}, not in this vault's ${S()}. Nothing was prepared.`, 422);
    if (q.verifier !== getAddress(VER())) throw new RailError("unknown_verifier", "This quote names a verifier other than the shared minimum-variance verifier. The escrow pays on whatever its verifier accepts, so QED funds only quotes that name the shared one. Nothing was prepared.", 422);
    const provider = workspaceOf(q.provider);
    if (!provider || getAddress(provider.a.vault) !== (arb ? arb.payee : q.payee)) throw new RailError("unknown_provider", "The quote's provider is not a workspace of this installation paid into its own treasury vault. Nothing was prepared.", 422);
    const used = (await readE("quoteUsed", [keccak256(encodeAbiParameters([{ type: "address" }, { type: "bytes32" }], [q.provider, q.quoteId]))])) as boolean;
    if (used) throw new RailError("quote_used", "This quote has already been used to open a job. Nothing was prepared.", 409);
    const now = await rail.chainNow();
    if (BigInt(q.validUntil) < now + 60n) throw new RailError("quote_expired", `This offer stood until ${new Date(Number(q.validUntil) * 1000).toISOString()}; ask the provider for a new one. Nothing was prepared.`, 409);
    if (BigInt(q.deliverBy) <= now) throw new RailError("quote_expired", "This quote's delivery deadline has passed. Nothing was prepared.", 409);
    if (!(await providerSignatureValid(q, sig))) throw new RailError("quote_signature_invalid", "The provider's owner account does not accept this signature for this quote: it was altered or signed by someone else. Nothing was prepared.", 409);
    let problem: Problem | null = null;
    if (p.spec !== undefined) {
      if (typeof p.spec !== "string" || !/^0x([0-9a-fA-F]{2})+$/.test(p.spec) || p.spec.length > 8200) throw bad("spec is the problem's encoding (hex).");
      if (keccak256(p.spec as Hex).toLowerCase() !== q.specHash) throw new RailError("spec_mismatch", "The problem given does not hash to the quote's specHash. Nothing was prepared.", 422);
      const [n, , tol] = decodeAbiParameters([{ type: "uint256" }, { type: "int256[]" }, { type: "uint256" }, { type: "bytes32" }], p.spec as Hex);
      problem = { kind: "custom", title: `Minimum-variance long-only portfolio of ${n} assets`, assets: [], correlations: "zero", n: Number(n), tolerance: `${tol} (WAD)`, universe: q.specHash, note: "Checked against the quote's specHash." };
    }
    const price = BigInt(q.price);
    const free = BigInt((await rail.snap(rail.a.vault)).freeBalance);
    const check = { id: "vault-free", rule: `Free ${S()} in this treasury vault (ring-fenced money cannot be withdrawn)`, limit: free.toString(), used: null, remaining: free.toString(), pass: price <= free };
    const terms = {
      kind: "escrow-fund", chainId: CHAIN_ID, genesisId: rail.genesisId, escrow: getAddress(E()), quote: q, signature: sig, problem, specHash: q.specHash,
      price: fmt(price).replace(/,/g, ""), priceRaw: price.toString(), payee: q.payee, provider: q.provider, deliverByTime: new Date(Number(q.deliverBy) * 1000).toISOString(),
      actions: arb ? [
        action(rail.a.vault, "QEDVault (treasury)", "withdraw", [o.address, price.toString()]),
        action(rail.a.asset!, rail.assetContract, "approve", [needD().address, price.toString()]),
        action(needD().address, "QEDDisputeEscrow", "open", [arbOut(arb), q, sig]),
      ] : [
        action(rail.a.vault, "QEDVault (treasury)", "withdraw", [o.address, price.toString()]),
        action(rail.a.asset!, rail.assetContract, "approve", [E(), price.toString()]),
        action(E(), "ProofEscrow", "open", [q, sig]),
      ],
      ...(arb ? { dispute: { escrow: getAddress(needD().address), terms: arbOut(arb), termsHash: q.quoteId, words: arbWords(arb, price) } } : {}),
      effect: arb
        ? `One transaction of the owner account: ${fmt(price)} ${S()} of the treasury vault's free funds go to the owner account, which lets the dispute escrow take exactly that and open the job through the proof escrow. The proof escrow then holds the money and releases it only to the dispute escrow, for a certificate the shared verifier accepts by ${new Date(Number(q.deliverBy) * 1000).toISOString()}; after that, anyone can return it to this owner account. Once the work is verified you review it under the terms below: you accept it, or dispute it, or the review's timeout applies.`
        : `One transaction of the owner account: ${fmt(price)} ${S()} of the treasury vault's free funds go to the owner account, which lets the escrow take exactly that and opens the job. The escrow then holds the money: it pays the provider's vault ${q.payee.slice(0, 10)}… only for a certificate the shared verifier accepts by ${new Date(Number(q.deliverBy) * 1000).toISOString()}; after that, anyone can return it to this owner account. There is no other way out of the escrow.`,
    };
    return { terms, summary: `Fund the job for ${fmt(price)} ${S()} from the treasury vault; the escrow pays the provider only for a verified certificate by ${terms.deliverByTime}.`, allowed: check.pass, checks: [check], replaces: [] as ProposalKind[] };
  });
  rail.handlers.set("escrow-fund", async (ctx): Promise<OpResult> => {
    const t = ctx.terms, price = BigInt(t.priceRaw);
    const refuse = (summary: string): OpResult => { ctx.push({ key: "escrow", label: "Refused before sending", status: "refused", detail: summary }); rail.record(ctx, { kind: "escrow", title: summary, outcome: "refused" }); return { outcome: "refused", summary }; };
    const used = (await readE("quoteUsed", [keccak256(encodeAbiParameters([{ type: "address" }, { type: "bytes32" }], [t.quote.provider, t.quote.quoteId]))])) as boolean;
    if (used) return refuse("This quote has already opened a job. Nothing was sent.");
    const free = BigInt((await rail.snap(rail.a.vault)).freeBalance);
    if (price > free) return refuse(`Refused before sending: the job costs ${fmt(price)} ${S()} and the treasury vault has ${fmt(free)} ${S()} of free funds. Nothing was sent.`);
    const tx = await rail.ownerSend(ctx, 0, A().QEDVaultAbi);
    const opened = await jobOpenedIn(tx.hash);
    if (!opened) throw new RailError("job_not_opened", `Transaction ${tx.hash} did not open the job. Inspect its receipt.`, 409);
    const disputeJobId = t.dispute ? (await disputeEvent(tx.hash, "JobOpened"))?.id?.toString() ?? null : null;
    if (t.dispute && !disputeJobId) throw new RailError("job_not_opened", `Transaction ${tx.hash} did not open the job in the dispute escrow. Inspect its receipt.`, 409);
    ctx.push({ key: "receipt", label: "ProofEscrow.open mined", status: "ok", detail: `Job #${opened.jobId} opened in block ${tx.blockNumber}: the escrow holds ${fmt(price)} ${S()} for the provider until ${t.deliverByTime}. ${rail.ownerWords("the withdrawal, the approval and the opening")}`, data: rail.txData(tx) });
    rail.store.appendDecision({ at: rail.iso(), kind: "escrow-fund", jobId: ctx.jobId, verdict: "SENT", clock: ctx.clock, approval: ctx.approval, termsHash: ctx.proposal!.termsHash, record: { escrowJobId: opened.jobId, quoteHash: opened.quoteHash, price: t.priceRaw, tx: rail.txBrief(tx) } });
    const summary = `Funded escrow job #${opened.jobId} with ${fmt(price)} ${S()} from the treasury vault; the provider is paid only for a verified certificate by ${t.deliverByTime}.`;
    rail.record(ctx, { kind: "escrow", title: summary, outcome: "executed", tx: rail.txBrief(tx) });
    return { outcome: "executed", summary, tx: rail.txBrief(tx), evidence: { escrowJobId: opened.jobId, quoteHash: opened.quoteHash, price: t.priceRaw, deliverBy: t.quote.deliverBy, ...(disputeJobId ? { disputeJobId } : {}) } };
  });
  rail.recoverers.set("escrow-fund", async (job) => (await rail.lookupSent(job, "owner:ProofEscrow.open", "escrow", "Escrow funded")) ?? rail.lookupSent(job, "owner:QEDDisputeEscrow.open", "escrow", "Escrow funded through the dispute escrow"));

  async function jobOpenedIn(hash: Hex): Promise<{ jobId: string; quoteHash: Hex } | null> {
    const r = await rail.pub.getTransactionReceipt({ hash });
    const ev = parseEventLogs({ abi: A().ProofEscrowAbi as never, logs: r.logs, eventName: "JobOpened" } as never) as unknown as { address: Address; args: { jobId: bigint; quoteHash: Hex } }[];
    const mine = ev.find((x) => getAddress(x.address) === getAddress(E()));
    return mine ? { jobId: mine.args.jobId.toString(), quoteHash: mine.args.quoteHash.toLowerCase() as Hex } : null;
  }
  /** An event of the dispute escrow in a transaction's receipt (its arguments), or null. */
  async function disputeEvent(hash: Hex, eventName: "JobOpened" | "Delivered" | "Disputed" | "EvidenceAdded" | "Closed"): Promise<any | null> {
    const d = needD();
    const r = await rail.pub.getTransactionReceipt({ hash });
    const ev = parseEventLogs({ abi: d.abi as never, logs: r.logs, eventName } as never) as unknown as { address: Address; args: any }[];
    return ev.find((x) => getAddress(x.address) === getAddress(d.address))?.args ?? null;
  }
  async function escrowEvent(hash: Hex, eventName: "JobSettled" | "JobRefunded"): Promise<any | null> {
    const r = await rail.pub.getTransactionReceipt({ hash });
    const ev = parseEventLogs({ abi: A().ProofEscrowAbi as never, logs: r.logs, eventName } as never) as unknown as { address: Address; args: any }[];
    return ev.find((x) => getAddress(x.address) === getAddress(E()))?.args ?? null;
  }

  /** A job read from the escrow: status, parties and terms. */
  async function getJob(id: unknown) {
    if (typeof id !== "string" || !/^\d{1,12}$/.test(id) || id === "0") throw new RailError("invalid_params", "An escrow job is named by its number.", 422);
    const j = (await readE("getJob", [BigInt(id)])) as { client: Address; provider: Address; payee: Address; token: Address; price: bigint; verifier: Address; specHash: Hex; deliverBy: bigint; status: number; quoteHash: Hex; solutionHash: Hex; resultDigest: Hex };
    if (Number(j.status) === 0) throw new RailError("unknown_escrow_job", "The escrow holds no such job.", 404);
    const did = viaDispute(j.client) ? ((await readD("jobOfEscrowJob", [BigInt(id)])) as bigint).toString() : "0";
    return { ...j, status: STATUS[Number(j.status)]!, disputeId: did === "0" ? null : did };
  }
  type DJob = { client: Address; provider: Address; payee: Address; decider: Address; token: Address; price: bigint; escrowJobId: bigint; termsHash: Hex; deciderMay: number; reviewPeriod: number; evidencePeriod: number; decisionPeriod: number; reviewTimeoutBps: number; decisionTimeoutBps: number; status: (typeof DISPUTE_STATUS)[number]; outcome: (typeof DISPUTE_OUTCOME)[number]; deliveredAt: bigint; disputedAt: bigint; closedAt: bigint; toProvider: bigint; toClient: bigint };
  /** A job of the dispute escrow. */
  async function getDispute(did: unknown): Promise<DJob> {
    if (typeof did !== "string" || !/^\d{1,12}$/.test(did) || did === "0") throw new RailError("invalid_params", "A job of the dispute escrow is named by its number.", 422);
    const j = (await readD("getJob", [BigInt(did)])) as any;
    if (Number(j.status) === 0) throw new RailError("unknown_dispute_job", "The dispute escrow holds no such job.", 404);
    return { ...j, deciderMay: Number(j.deciderMay), reviewPeriod: Number(j.reviewPeriod), evidencePeriod: Number(j.evidencePeriod), decisionPeriod: Number(j.decisionPeriod), reviewTimeoutBps: Number(j.reviewTimeoutBps), decisionTimeoutBps: Number(j.decisionTimeoutBps), status: DISPUTE_STATUS[Number(j.status)]!, outcome: DISPUTE_OUTCOME[Number(j.outcome)]! };
  }
  /** This workspace's parts in a job: refused (404) when it has none, as for every other record of another workspace. */
  async function partyJob(id: unknown) {
    const j = await getJob(id);
    const roles = await rolesOf(j);
    if (!roles.length) throw new RailError("unknown_escrow_job", "This workspace is not a party to that escrow job.", 404);
    return { j, roles };
  }
  const rolesOf = async (j: { client: Address; provider: Address; payee: Address; disputeId?: string | null }) => {
    const acct = getAddress(rail.a.ownerAccount!), vault = getAddress(rail.a.vault);
    const roles: ("client" | "provider" | "payee" | "decider")[] = [];
    if (j.disputeId) {
      // through the dispute escrow: the proof escrow's client and payee are the dispute escrow; the parties are in its terms
      const dj = await getDispute(j.disputeId);
      if (getAddress(dj.client) === acct) roles.push("client");
      if (getAddress(j.provider) === acct) roles.push("provider");
      if (getAddress(dj.payee) === vault) roles.push("payee");
      if (getAddress(dj.decider) === acct) roles.push("decider");
      return roles;
    }
    if (getAddress(j.client) === acct) roles.push("client");
    if (getAddress(j.provider) === acct) roles.push("provider");
    if (getAddress(j.payee) === vault) roles.push("payee");
    return roles;
  };

  // ───────────── PROVIDER: deliver ─────────────
  rail.proposers.set("escrow-deliver", async (p) => {
    const o = owner();
    if (Object.keys(p).some((k) => !["jobId", "solution"].includes(k))) throw bad("escrow-deliver takes { jobId, solution? }.");
    const j = await getJob(p.jobId);
    if (getAddress(j.provider) !== o.address) throw new RailError("not_the_provider", "Only the job's provider can deliver it. Nothing was prepared.", 409);
    if (j.status !== "open") throw new RailError("job_not_open", `This job is ${j.status}: there is nothing to deliver. Nothing was prepared.`, 409);
    if ((await rail.chainNow()) > j.deliverBy) throw new RailError("deadline_passed", `The delivery deadline ${new Date(Number(j.deliverBy) * 1000).toISOString()} has passed: the escrow refuses a late delivery, and the client can take the money back. Nothing was prepared.`, 409);
    const kept = rail.store.meta<{ quote: EscrowQuote; spec: Hex; problem: Problem; title: string }>(`escrow:quote:${String(j.quoteHash).toLowerCase()}`);
    if (!kept) throw new RailError("spec_unknown", "This workspace did not sign the quote of this job, so it does not hold its problem. Nothing was prepared.", 409);
    const spec = decodeSpec(kept.spec);
    let bytes: Hex, report: any = null, weights: { asset: string; weight: string }[] = [];
    if (p.solution !== undefined) {
      if (typeof p.solution !== "string" || !/^0x([0-9a-fA-F]{2})+$/.test(p.solution) || p.solution.length > 8200) throw bad("solution is the certificate's encoding (hex): abi.encode(int256[] w, int256 nu, int256[] mu, int256[] L).");
      bytes = p.solution as Hex;
    } else {
      const c = certificate(spec);
      bytes = c.bytes; report = c.report;
      weights = c.sol.w.map((w: bigint, i: number) => ({ asset: kept.problem.assets[i]?.name ?? `asset ${i + 1}`, weight: pct(w) }));
    }
    // the verifier, through the escrow's own dry run: what deliver() would check, without changing anything
    let variance: Hex;
    try { variance = (await readE("check", [BigInt(p.jobId as string), kept.spec, bytes])) as Hex; }
    catch (e) {
      const d = rail.v.chain.decodeRevert(e);
      throw new RailError("verification_failed", `The verifier refuses this certificate: ${d.name}(${d.args.map((x: unknown) => String(x)).join(", ")}). The escrow would revert and pay nothing. Nothing was signed or sent.`, 422, { error: d.name, args: d.args.map((x: unknown) => String(x)) });
    }
    const terms = {
      kind: "escrow-deliver", chainId: CHAIN_ID, genesisId: rail.genesisId, escrow: getAddress(E()), jobId: String(p.jobId), quoteHash: String(j.quoteHash).toLowerCase(), title: kept.title,
      price: fmt(j.price).replace(/,/g, ""), priceRaw: j.price.toString(), payee: getAddress(j.payee), client: getAddress(j.client), deliverByTime: new Date(Number(j.deliverBy) * 1000).toISOString(),
      problem: kept.problem, evidence: { solutionHash: keccak256(bytes).toLowerCase(), variance: BigInt(variance).toString(), varianceText: (Number(BigInt(variance)) / 1e18).toPrecision(8), weights, computedBy: p.solution === undefined ? "the release's certifying solver (agent/src/engine/minvar.ts), on this rail" : "supplied by the caller", checks: report ? { sumW: report.sumW.toString(), maxStationarityResidual: report.maxStationarityResidual.toString(), dualityGap: report.dualityGap.toString(), maxPsdResidual: report.maxPsdResidual.toString(), optimalityBound: report.optimalityBound } : null },
      actions: j.disputeId
        ? [action(E(), "ProofEscrow", "deliver", [String(p.jobId), kept.spec, bytes]), action(needD().address, "QEDDisputeEscrow", "noteDelivered", [j.disputeId])]
        : [action(E(), "ProofEscrow", "deliver", [String(p.jobId), kept.spec, bytes])],
      ...(j.disputeId ? { disputeJobId: j.disputeId } : {}),
      effect: j.disputeId
        ? await (async () => { const dj = await getDispute(j.disputeId!); const [pp] = splitOf(j.price, dj.reviewTimeoutBps); return `The escrow asks the shared verifier to check this certificate. It accepts it now (the escrow's own dry run), so the proof escrow pays ${fmt(j.price)} ${S()} to the dispute escrow in the same transaction, and the client's review of ${span(dj.reviewPeriod)} starts in the same block. The client may accept the work (paid in full at once) or dispute it; with no answer by the end of the review, ${fmt(pp)} ${S()} reaches this workspace's vault. Had the verifier refused, the transaction would revert and nothing would move.`; })()
        : `The escrow asks the shared verifier to check this certificate. It accepts it now (the escrow's own dry run), so the escrow pays ${fmt(j.price)} ${S()} to this workspace's vault in the same transaction. Had it not, the transaction would revert and nothing would move.`,
    };
    return { terms, summary: `Deliver the certified portfolio for job #${String(p.jobId)}; the escrow pays ${fmt(j.price)} ${S()} to this vault on verification.`, allowed: true, checks: [], replaces: [] as ProposalKind[] };
  });
  const decodeSpec = (bytes: Hex) => {
    const [n, cov, tol, universe] = decodeAbiParameters([{ type: "uint256" }, { type: "int256[]" }, { type: "uint256" }, { type: "bytes32" }], bytes);
    return { n: Number(n), cov: [...cov], tol, universe };
  };
  rail.handlers.set("escrow-deliver", async (ctx): Promise<OpResult> => {
    const t = ctx.terms;
    const j = await getJob(t.jobId);
    if (j.status !== "open") { const summary = `Job #${t.jobId} is already ${j.status}; nothing was sent.`; rail.record(ctx, { kind: "escrow", title: summary, outcome: "no-action" }); return { outcome: "no-action", summary }; }
    const tx = await rail.ownerSend(ctx, 0, A().ProofEscrowAbi);
    const settled = await escrowEvent(tx.hash, "JobSettled");
    if (!settled) throw new RailError("job_not_settled", `Transaction ${tx.hash} did not settle the job. Inspect its receipt.`, 409);
    if (t.disputeJobId) {
      const noted = await disputeEvent(tx.hash, "Delivered");
      if (!noted) throw new RailError("delivery_not_noted", `Transaction ${tx.hash} settled the job but did not start its review. Inspect its receipt.`, 409);
      const ends = new Date(Number(noted.reviewEndsAt) * 1000).toISOString();
      ctx.push({ key: "receipt", label: "Verified and held for the client's review", status: "ok", detail: `The verifier accepted the certificate; the proof escrow paid ${fmt(settled.price)} ${S()} to the dispute escrow, and the client's review runs until ${ends}, in block ${tx.blockNumber}. ${rail.ownerWords("the delivery")}`, data: rail.txData(tx) });
      rail.store.appendDecision({ at: rail.iso(), kind: "escrow-deliver", jobId: ctx.jobId, verdict: "HELD-FOR-REVIEW", clock: ctx.clock, approval: ctx.approval, termsHash: ctx.proposal!.termsHash, record: { escrowJobId: t.jobId, disputeJobId: t.disputeJobId, solutionHash: String(settled.solutionHash).toLowerCase(), reviewEndsAt: String(noted.reviewEndsAt), tx: rail.txBrief(tx) } });
      const summary = `Delivered job #${t.jobId}: the verifier accepted the certificate; the dispute escrow holds ${fmt(settled.price)} ${S()} for the client's review until ${ends}.`;
      rail.record(ctx, { kind: "escrow", title: summary, outcome: "executed", tx: rail.txBrief(tx) });
      return { outcome: "executed", summary, tx: rail.txBrief(tx), evidence: { escrowJobId: t.jobId, disputeJobId: t.disputeJobId, price: settled.price.toString(), solutionHash: String(settled.solutionHash).toLowerCase(), resultDigest: String(settled.resultDigest).toLowerCase(), reviewEndsAt: String(noted.reviewEndsAt) } };
    }
    ctx.push({ key: "receipt", label: "ProofEscrow.deliver mined: verified and settled", status: "ok", detail: `The verifier accepted the certificate and the escrow paid ${fmt(settled.price)} ${S()} to ${String(settled.payee).slice(0, 10)}… in block ${tx.blockNumber}. ${rail.ownerWords("the delivery")}`, data: rail.txData(tx) });
    rail.store.appendDecision({ at: rail.iso(), kind: "escrow-deliver", jobId: ctx.jobId, verdict: "SETTLED", clock: ctx.clock, approval: ctx.approval, termsHash: ctx.proposal!.termsHash, record: { escrowJobId: t.jobId, solutionHash: String(settled.solutionHash).toLowerCase(), resultDigest: String(settled.resultDigest).toLowerCase(), tx: rail.txBrief(tx) } });
    const summary = `Delivered job #${t.jobId}: the verifier accepted the certificate and the escrow paid ${fmt(settled.price)} ${S()} into this vault.`;
    rail.record(ctx, { kind: "escrow", title: summary, outcome: "executed", tx: rail.txBrief(tx) });
    return { outcome: "executed", summary, tx: rail.txBrief(tx), evidence: { escrowJobId: t.jobId, payee: settled.payee, price: settled.price.toString(), solutionHash: String(settled.solutionHash).toLowerCase(), resultDigest: String(settled.resultDigest).toLowerCase() } };
  });
  rail.recoverers.set("escrow-deliver", async (job) => (await rail.lookupSent(job, "owner:ProofEscrow.deliver", "escrow", "Job delivered")) ?? rail.lookupSent(job, "owner:QEDDisputeEscrow.noteDelivered", "escrow", "Job delivered for review"));

  // ───────────── PROVIDER: release the client before the deadline ─────────────
  rail.proposers.set("escrow-release", async (p) => {
    const o = owner();
    if (Object.keys(p).some((k) => k !== "jobId")) throw bad("escrow-release takes { jobId }.");
    const j = await getJob(p.jobId);
    if (getAddress(j.provider) !== o.address) throw new RailError("not_the_provider", "Only the job's provider can release its client before the deadline; after it, anyone can refund. Nothing was prepared.", 409);
    if (j.status !== "open") throw new RailError("job_not_open", `This job is ${j.status}. Nothing was prepared.`, 409);
    const dj = j.disputeId ? await getDispute(j.disputeId) : null;
    const client = getAddress(dj ? dj.client : j.client);
    const terms = { kind: "escrow-release", chainId: CHAIN_ID, genesisId: rail.genesisId, escrow: getAddress(E()), jobId: String(p.jobId), price: fmt(j.price).replace(/,/g, ""), priceRaw: j.price.toString(), client, ...(dj ? { disputeJobId: j.disputeId } : {}), actions: dj ? [action(E(), "ProofEscrow", "refund", [String(p.jobId)]), action(needD().address, "QEDDisputeEscrow", "reclaim", [j.disputeId])] : [action(E(), "ProofEscrow", "refund", [String(p.jobId)])], effect: `The escrow returns ${fmt(j.price)} ${S()} to the client's owner account ${client.slice(0, 10)}… now${dj ? ", through the dispute escrow" : ""}. This workspace gives up the job: nothing is paid to its vault.` };
    return { terms, summary: `Release the client of job #${String(p.jobId)}: the escrow refunds ${fmt(j.price)} ${S()} to it now.`, allowed: true, checks: [], replaces: [] as ProposalKind[] };
  });
  rail.handlers.set("escrow-release", async (ctx): Promise<OpResult> => {
    const t = ctx.terms;
    const j = await getJob(t.jobId);
    if (j.status !== "open") { const summary = `Job #${t.jobId} is already ${j.status}; nothing was sent.`; rail.record(ctx, { kind: "escrow", title: summary, outcome: "no-action" }); return { outcome: "no-action", summary }; }
    const tx = await rail.ownerSend(ctx, 0, A().ProofEscrowAbi);
    const refunded = await escrowEvent(tx.hash, "JobRefunded");
    if (!refunded) throw new RailError("job_not_refunded", `Transaction ${tx.hash} did not refund the job. Inspect its receipt.`, 409);
    if (t.disputeJobId && !(await disputeEvent(tx.hash, "Closed"))) throw new RailError("job_not_refunded", `Transaction ${tx.hash} refunded the proof escrow but the dispute escrow did not pay the client. Inspect its receipt.`, 409);
    const summary = `Released the client of job #${t.jobId}: the escrow refunded ${fmt(refunded.price)} ${S()} to its owner account.`;
    ctx.push({ key: "receipt", label: "ProofEscrow.refund mined", status: "ok", detail: `${summary} Block ${tx.blockNumber}.`, data: rail.txData(tx) });
    rail.record(ctx, { kind: "escrow", title: summary, outcome: "executed", tx: rail.txBrief(tx) });
    return { outcome: "executed", summary, tx: rail.txBrief(tx), evidence: { escrowJobId: t.jobId, client: refunded.client, price: refunded.price.toString() } };
  });
  rail.recoverers.set("escrow-release", async (job) => (await rail.lookupSent(job, "owner:ProofEscrow.refund", "escrow", "Client released")) ?? rail.lookupSent(job, "owner:QEDDisputeEscrow.reclaim", "escrow", "Client released"));

  // ───────────── ANYONE, after the deadline: refund (the rail's relayer; no approval) ─────────────
  /** Validates POST /escrow/jobs/:jobId/refund before anything is stored: this workspace must be a party to the job. */
  async function refundParams(id: unknown): Promise<{ jobId: string }> {
    owner();
    await partyJob(id);
    return { jobId: String(id) };
  }
  rail.handlers.set("escrow-refund", async (ctx): Promise<OpResult> => {
    const id = String(ctx.request.jobId);
    const j = await getJob(id);
    const refuse = (outcome: "refused" | "no-action", summary: string): OpResult => { ctx.push({ key: "escrow", label: outcome === "refused" ? "Not refundable yet" : "Nothing to refund", status: outcome === "refused" ? "refused" : "info", detail: summary }); rail.record(ctx, { kind: "escrow", title: summary, outcome }); return { outcome, summary }; };
    if (j.disputeId) {
      // through the dispute escrow: its reclaim refunds the proof escrow (after the deadline) and pays the client
      const dj = await getDispute(j.disputeId);
      if (dj.status !== "funded") return refuse("no-action", `Job #${id} is ${dj.status} in the dispute escrow: there is nothing to refund. Nothing was sent.`);
      if (j.status === "settled") return refuse("refused", `Job #${id} was delivered and verified: it goes to the client's review, not back to the client. Nothing was sent.`);
      ctx.clock = await rail.align();
      if (j.status === "open" && (await rail.chainNow()) <= j.deliverBy) return refuse("refused", `Job #${id} can be refunded by anyone only after its deadline, ${new Date(Number(j.deliverBy) * 1000).toISOString()}; before it, only the provider can release the client. Nothing was sent.`);
      const d = needD();
      const tx = await rail.send(ctx, "relay:QEDDisputeEscrow.reclaim", rail.relayer!, d.address, encodeFunctionData({ abi: d.abi, functionName: "reclaim", args: [BigInt(j.disputeId)] }));
      const closed = await disputeEvent(tx.hash, "Closed");
      if (!closed) throw new RailError("job_not_refunded", `Transaction ${tx.hash} did not refund the job. Inspect its receipt.`, 409);
      const summary = `Refunded job #${id} after its deadline: the dispute escrow returned ${fmt(closed.toClient)} ${S()} to the client's owner account ${String(dj.client).slice(0, 10)}…. No verified delivery arrived in time, so nothing was paid to the provider.`;
      ctx.push({ key: "receipt", label: "QEDDisputeEscrow.reclaim mined", status: "ok", detail: `${summary} Relayed by the rail (anyone may after the deadline), block ${tx.blockNumber}.`, data: rail.txData(tx) });
      rail.record(ctx, { kind: "escrow", title: summary, outcome: "executed", tx: rail.txBrief(tx) });
      return { outcome: "executed", summary, tx: rail.txBrief(tx), evidence: { escrowJobId: id, disputeJobId: j.disputeId, client: dj.client, price: closed.toClient.toString() } };
    }
    if (j.status !== "open") return refuse("no-action", `Job #${id} is ${j.status}: there is nothing to refund. Nothing was sent.`);
    ctx.clock = await rail.align();
    if ((await rail.chainNow()) <= j.deliverBy) return refuse("refused", `Job #${id} can be refunded by anyone only after its deadline, ${new Date(Number(j.deliverBy) * 1000).toISOString()}; before it, only the provider can release the client. Nothing was sent.`);
    const tx = await rail.send(ctx, "relay:ProofEscrow.refund", rail.relayer!, E(), rail.v.chain.fn(A().ProofEscrowAbi, "refund", [BigInt(id)]));
    const refunded = await escrowEvent(tx.hash, "JobRefunded");
    if (!refunded) throw new RailError("job_not_refunded", `Transaction ${tx.hash} did not refund the job. Inspect its receipt.`, 409);
    const summary = `Refunded job #${id} after its deadline: the escrow returned ${fmt(refunded.price)} ${S()} to the client's owner account ${String(refunded.client).slice(0, 10)}…. No valid certificate arrived in time, so nothing was paid to the provider.`;
    ctx.push({ key: "receipt", label: "ProofEscrow.refund mined", status: "ok", detail: `${summary} Relayed by the rail (anyone may after the deadline), block ${tx.blockNumber}.`, data: rail.txData(tx) });
    rail.record(ctx, { kind: "escrow", title: summary, outcome: "executed", tx: rail.txBrief(tx) });
    return { outcome: "executed", summary, tx: rail.txBrief(tx), evidence: { escrowJobId: id, client: refunded.client, price: refunded.price.toString() } };
  });
  rail.recoverers.set("escrow-refund", async (job) => (await rail.lookupSent(job, "relay:ProofEscrow.refund", "escrow", "Refunded")) ?? rail.lookupSent(job, "relay:QEDDisputeEscrow.reclaim", "escrow", "Refunded"));

  // ───────────── the review and dispute step (QEDDisputeEscrow, R13 E3) ─────────────
  const cleanText = (v: unknown, min: number, max: number, what: string) => {
    const t = typeof v === "string" ? v.replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, " ").trim() : "";
    if (t.length < min || t.length > max) throw bad(`${what} is ${min} to ${max} characters of text.`);
    return t;
  };
  const textHash = (t: string) => keccak256(toHex(t)).toLowerCase() as Hex;
  const isoOf = (x: bigint | number) => new Date(Number(x) * 1000).toISOString();
  const dAction = (fn: string, args: unknown[]) => action(needD().address, "QEDDisputeEscrow", fn, args);
  /** One job of the dispute escrow in the role a step needs, with the chain's time and its deadlines; or a refusal. */
  async function disputeAs(p: Record<string, unknown>, keys: string[], kind: string, role: "client" | "provider" | "decider" | "party") {
    owner();
    if (Object.keys(p).some((k) => !keys.includes(k)) || !("disputeId" in p)) throw bad(`${kind} takes { ${keys.join(", ")} }.`);
    const dj = await getDispute(p.disputeId);
    const acct = getAddress(rail.a.ownerAccount!);
    const is = { client: getAddress(dj.client) === acct, provider: getAddress(dj.provider) === acct, decider: getAddress(dj.decider) === acct };
    if (!is.client && !is.provider && !is.decider) throw new RailError("unknown_dispute_job", "This workspace is not a party to that job of the dispute escrow, nor its decider.", 404);
    if (!(role === "party" ? is.client || is.provider : is[role])) throw new RailError(role === "party" ? "not_a_party" : `not_the_${role}`, `Only the job's ${role === "party" ? "client or provider" : role} may do this. Nothing was prepared.`, 409);
    const now = await rail.chainNow();
    const d = { reviewEnds: dj.deliveredAt + BigInt(dj.reviewPeriod), evidenceEnds: dj.disputedAt + BigInt(dj.evidencePeriod), decideBy: dj.disputedAt + BigInt(dj.decisionPeriod) };
    return { dj, now, d, id: String(p.disputeId), role: is.client ? "client" : is.provider ? "provider" : "decider" };
  }
  const dTerms = (kind: string, x: { dj: DJob; id: string }, extra: Record<string, unknown>) => ({ kind, chainId: CHAIN_ID, genesisId: rail.genesisId, disputeEscrow: getAddress(needD().address), disputeJobId: x.id, escrowJobId: x.dj.escrowJobId.toString(), price: fmt(x.dj.price).replace(/,/g, ""), priceRaw: x.dj.price.toString(), client: getAddress(x.dj.client), provider: getAddress(x.dj.provider), payee: getAddress(x.dj.payee), decider: getAddress(x.dj.decider), ...extra });
  const proposal = (terms: Record<string, unknown>, summary: string) => ({ terms, summary, allowed: true, checks: [], replaces: [] as ProposalKind[] });

  rail.proposers.set("escrow-accept", async (p) => {
    const x = await disputeAs(p, ["disputeId"], "escrow-accept", "client");
    if (x.dj.status !== "delivered" && x.dj.status !== "disputed") throw new RailError("wrong_state", `This job is ${x.dj.status}: there is no verified work to accept. Nothing was prepared.`, 409);
    return proposal(dTerms("escrow-accept", x, { actions: [dAction("accept", [x.id])], effect: `The dispute escrow pays ${fmt(x.dj.price)} ${S()} to the provider's vault ${String(x.dj.payee).slice(0, 10)}… now${x.dj.status === "disputed" ? ", and your dispute ends" : ""}. This cannot be undone.` }), `Accept the work of job #${x.id}: the provider is paid ${fmt(x.dj.price)} ${S()} in full.`);
  });
  rail.proposers.set("escrow-dispute", async (p) => {
    const x = await disputeAs(p, ["disputeId", "reason"], "escrow-dispute", "client");
    const reason = cleanText(p.reason, 10, 2000, "reason");
    if (x.dj.status !== "delivered") throw new RailError("wrong_state", `This job is ${x.dj.status}: only verified work under review can be disputed. Nothing was prepared.`, 409);
    if (x.now > x.d.reviewEnds) throw new RailError("review_over", `The review ended at ${isoOf(x.d.reviewEnds)}: the dispute escrow no longer accepts a dispute, and anyone may apply the review's outcome. Nothing was prepared.`, 409);
    const hash = textHash(reason);
    return proposal(dTerms("escrow-dispute", x, { reason, reasonHash: hash, actions: [dAction("dispute", [x.id, hash])], effect: `The job is disputed and the money stays in the dispute escrow. Both sides have ${span(x.dj.evidencePeriod)} to add evidence; then the decider ${String(x.dj.decider).slice(0, 10)}… rules, at the latest ${span(x.dj.decisionPeriod)} from now. With no ruling by then, ${pctOf(x.dj.decisionTimeoutBps)} goes to the provider. Only the reason's keccak256 goes on the chain; QED keeps the text and shows it to the provider and the decider.` }), `Dispute the work of job #${x.id}, with your reason.`);
  });
  rail.proposers.set("escrow-evidence", async (p) => {
    const x = await disputeAs(p, ["disputeId", "text"], "escrow-evidence", "party");
    const text = cleanText(p.text, 10, 2000, "text");
    if (x.dj.status !== "disputed") throw new RailError("wrong_state", `This job is ${x.dj.status}: evidence goes with a dispute. Nothing was prepared.`, 409);
    if (x.now > x.d.evidenceEnds) throw new RailError("evidence_closed", `The evidence period ended at ${isoOf(x.d.evidenceEnds)}. Nothing was prepared.`, 409);
    const hash = textHash(text);
    return proposal(dTerms("escrow-evidence", x, { by: x.role, text, evidenceHash: hash, actions: [dAction("addEvidence", [x.id, hash])], effect: `Adds this evidence to the dispute, as the ${x.role}. Only its keccak256 goes on the chain; QED keeps the text and shows it to the other side and the decider. Moves no money.` }), `Add evidence to the dispute of job #${x.id}, as the ${x.role}.`);
  });
  rail.proposers.set("escrow-decide", async (p) => {
    const x = await disputeAs(p, ["disputeId", "toProvider"], "escrow-decide", "decider");
    if (x.dj.status !== "disputed") throw new RailError("wrong_state", `This job is ${x.dj.status}: the decider rules only on a dispute. Nothing was prepared.`, 409);
    if (x.now <= x.d.evidenceEnds) throw new RailError("evidence_open", `The evidence period runs until ${isoOf(x.d.evidenceEnds)}: the decider rules after it. Nothing was prepared.`, 409);
    if (x.now > x.d.decideBy) throw new RailError("decision_over", `The decision deadline was ${isoOf(x.d.decideBy)}: the terms' timeout outcome applies now, and anyone may apply it. Nothing was prepared.`, 409);
    // S5: at the treasury token's own decimals (tINR 2, tJPY 0, tBHD 3, tEUR 6)
    const d = rail.asset.decimals, places = new RegExp(d ? `^\\d{1,12}(\\.\\d{1,${d}})?$` : "^\\d{1,12}$");
    if (!(typeof p.toProvider === "string" && places.test(p.toProvider))) throw bad(`toProvider is the provider's part, a decimal amount of ${S()} with at most ${d === 2 ? "two" : d} decimals.`);
    const toProvider = rail.raw(p.toProvider, "The provider's part");
    if (toProvider > x.dj.price) throw new RailError("invalid_amount", `The provider's part is from 0 to the price, ${fmt(x.dj.price)} ${S()}.`, 422);
    const need = toProvider === x.dj.price ? DISPUTE.MAY_PAY_PROVIDER : toProvider === 0n ? DISPUTE.MAY_REFUND_CLIENT : DISPUTE.MAY_SPLIT;
    if (!(x.dj.deciderMay & need)) throw new RailError("outcome_not_allowed", `The terms do not let the decider ${powers(need)[0]}: it may ${powers(x.dj.deciderMay).join(", or ")}. Nothing was prepared.`, 422);
    const toClient = x.dj.price - toProvider;
    return proposal(dTerms("escrow-decide", x, { toProvider: fmt(toProvider).replace(/,/g, ""), toProviderRaw: toProvider.toString(), toClient: fmt(toClient).replace(/,/g, ""), toClientRaw: toClient.toString(), actions: [dAction("decide", [x.id, toProvider.toString()])], effect: `As the named decider you rule: ${fmt(toProvider)} ${S()} to the provider's vault and ${fmt(toClient)} ${S()} to the client's owner account, paid by the dispute escrow now. The ruling is final on the chain, and you receive nothing.` }), `Rule on the dispute of job #${x.id}: ${fmt(toProvider)} ${S()} to the provider, ${fmt(toClient)} ${S()} to the client.`);
  });
  rail.proposers.set("escrow-give-way", async (p) => {
    const x = await disputeAs(p, ["disputeId"], "escrow-give-way", "provider");
    if (x.dj.status !== "delivered" && x.dj.status !== "disputed") throw new RailError("wrong_state", `This job is ${x.dj.status}: there is nothing to give back. Nothing was prepared.`, 409);
    return proposal(dTerms("escrow-give-way", x, { actions: [dAction("giveWay", [x.id])], effect: `The dispute escrow refunds ${fmt(x.dj.price)} ${S()} to the client's owner account now. This workspace gives up the payment for this work. This cannot be undone.` }), `Refund the client of job #${x.id} in full: ${fmt(x.dj.price)} ${S()}.`);
  });
  /** The five dispute steps: the owner account's execute, then the dispute escrow's own event as the evidence. */
  const disputeStep = (kind: string, eventName: "Closed" | "Disputed" | "EvidenceAdded", label: string) => async (ctx: Ctx): Promise<OpResult> => {
    const t = ctx.terms;
    const dj = await getDispute(t.disputeJobId);
    const open = eventName === "Disputed" ? dj.status === "delivered" : eventName === "EvidenceAdded" ? dj.status === "disputed" : dj.status === "delivered" || dj.status === "disputed";
    if (!open) { const summary = `Job #${t.disputeJobId} of the dispute escrow is ${dj.status}${dj.status === "closed" ? ` (${dj.outcome})` : ""}; nothing was sent.`; rail.record(ctx, { kind: "escrow", title: summary, outcome: "no-action" }); return { outcome: "no-action", summary }; }
    ctx.clock = await rail.align(); // the deadlines are the chain's: the next block, and the simulation, carry the rail's clock
    const tx = await rail.ownerSend(ctx, 0, needD().abi);
    const ev = await disputeEvent(tx.hash, eventName);
    if (!ev) throw new RailError("dispute_step_missing", `Transaction ${tx.hash} did not record that the ${label}. Inspect its receipt.`, 409);
    const summary = eventName === "Closed"
      ? `Job #${t.disputeJobId}: ${label}. ${fmt(ev.toProvider)} ${S()} to the provider, ${fmt(ev.toClient)} ${S()} to the client.`
      : eventName === "Disputed" ? `Job #${t.disputeJobId} disputed: evidence until ${isoOf(ev.evidenceEndsAt)}, a ruling by ${isoOf(ev.decideBy)}.` : `Job #${t.disputeJobId}: evidence added by the ${t.by}.`;
    ctx.push({ key: "receipt", label: `QEDDisputeEscrow mined: ${label}`, status: "ok", detail: `${summary} Block ${tx.blockNumber}. ${rail.ownerWords("the step")}`, data: rail.txData(tx) });
    rail.store.appendDecision({ at: rail.iso(), kind, jobId: ctx.jobId, verdict: "SENT", clock: ctx.clock, approval: ctx.approval, termsHash: ctx.proposal!.termsHash, record: { disputeJobId: t.disputeJobId, tx: rail.txBrief(tx), ...(t.reasonHash ? { reasonHash: t.reasonHash } : {}), ...(t.evidenceHash ? { evidenceHash: t.evidenceHash } : {}) } });
    rail.record(ctx, { kind: "escrow", title: summary, outcome: "executed", tx: rail.txBrief(tx) });
    return { outcome: "executed", summary, tx: rail.txBrief(tx), evidence: { disputeJobId: t.disputeJobId, escrowJobId: t.escrowJobId, ...(eventName === "Closed" ? { toProvider: ev.toProvider.toString(), toClient: ev.toClient.toString(), outcome: DISPUTE_OUTCOME[Number(ev.outcome)] } : {}), ...(t.reason ? { reason: t.reason, reasonHash: t.reasonHash } : {}), ...(t.text ? { text: t.text, evidenceHash: t.evidenceHash, by: t.by } : {}) } };
  };
  rail.handlers.set("escrow-accept", disputeStep("escrow-accept", "Closed", "the client accepted the work"));
  rail.handlers.set("escrow-dispute", disputeStep("escrow-dispute", "Disputed", "the client disputed the work"));
  rail.handlers.set("escrow-evidence", disputeStep("escrow-evidence", "EvidenceAdded", "evidence was added"));
  rail.handlers.set("escrow-decide", disputeStep("escrow-decide", "Closed", "the decider ruled"));
  rail.handlers.set("escrow-give-way", disputeStep("escrow-give-way", "Closed", "the provider refunded the client"));
  for (const [k, fn] of [["escrow-accept", "accept"], ["escrow-dispute", "dispute"], ["escrow-evidence", "addEvidence"], ["escrow-decide", "decide"], ["escrow-give-way", "giveWay"]] as const) rail.recoverers.set(k, (job) => rail.lookupSent(job, `owner:QEDDisputeEscrow.${fn}`, "escrow", "Dispute step sent"));

  // ───────────── ANYONE, once a period has run out: the terms' timeout outcome (the rail's relayer; no approval) ─────────────
  /** Validates POST /disputes/:disputeId/finish before anything is stored: this workspace must be a party or the decider. */
  async function finishParams(id: unknown): Promise<{ disputeId: string }> {
    owner();
    const dj = await getDispute(id);
    const acct = getAddress(rail.a.ownerAccount!);
    if (![dj.client, dj.provider, dj.decider].some((a) => getAddress(a) === acct)) throw new RailError("unknown_dispute_job", "This workspace is not a party to that job of the dispute escrow, nor its decider.", 404);
    return { disputeId: String(id) };
  }
  rail.handlers.set("escrow-finish", async (ctx): Promise<OpResult> => {
    const id = String(ctx.request.disputeId);
    const dj = await getDispute(id);
    const refuse = (outcome: "refused" | "no-action", summary: string): OpResult => { ctx.push({ key: "escrow", label: outcome === "refused" ? "Not due yet" : "Nothing to apply", status: outcome === "refused" ? "refused" : "info", detail: summary }); rail.record(ctx, { kind: "escrow", title: summary, outcome }); return { outcome, summary }; };
    if (dj.status !== "delivered" && dj.status !== "disputed") return refuse("no-action", `Job #${id} of the dispute escrow is ${dj.status}: no timeout applies. Nothing was sent.`);
    ctx.clock = await rail.align();
    const due = dj.status === "delivered" ? dj.deliveredAt + BigInt(dj.reviewPeriod) : dj.disputedAt + BigInt(dj.decisionPeriod);
    if ((await rail.chainNow()) <= due) return refuse("refused", `Job #${id}'s ${dj.status === "delivered" ? "review" : "decision period"} runs until ${isoOf(due)}; its timeout applies only after that. Nothing was sent.`);
    const d = needD();
    const tx = await rail.send(ctx, "relay:QEDDisputeEscrow.finish", rail.relayer!, d.address, encodeFunctionData({ abi: d.abi, functionName: "finish", args: [BigInt(id)] }));
    const closed = await disputeEvent(tx.hash, "Closed");
    if (!closed) throw new RailError("not_finished", `Transaction ${tx.hash} did not apply the timeout. Inspect its receipt.`, 409);
    const summary = `Applied the ${dj.status === "delivered" ? "review" : "decision"} timeout of job #${id}, as its terms say: ${fmt(closed.toProvider)} ${S()} to the provider, ${fmt(closed.toClient)} ${S()} to the client.`;
    ctx.push({ key: "receipt", label: "QEDDisputeEscrow.finish mined", status: "ok", detail: `${summary} Relayed by the rail (anyone may once the period has run out), block ${tx.blockNumber}.`, data: rail.txData(tx) });
    rail.record(ctx, { kind: "escrow", title: summary, outcome: "executed", tx: rail.txBrief(tx) });
    return { outcome: "executed", summary, tx: rail.txBrief(tx), evidence: { disputeJobId: id, escrowJobId: dj.escrowJobId.toString(), toProvider: closed.toProvider.toString(), toClient: closed.toClient.toString(), outcome: DISPUTE_OUTCOME[Number(closed.outcome)] } };
  });
  rail.recoverers.set("escrow-finish", (job) => rail.lookupSent(job, "relay:QEDDisputeEscrow.finish", "escrow", "Timeout applied"));

  /** A job of the dispute escrow as this workspace sees it, with what each side may do now by the chain's time. */
  async function disputeView(did: string, roles: string[]): Promise<DisputeJobView> {
    const d = needD();
    const dj = await getDispute(did);
    const now = Number(await rail.chainNow());
    const ev = (eventName: string) => rail.pub.getContractEvents({ address: d.address, abi: d.abi, eventName, args: { id: BigInt(did) }, fromBlock: BigInt(d.deployBlock) } as never) as Promise<any[]>;
    const [disp, evid] = await Promise.all([ev("Disputed"), ev("EvidenceAdded")]);
    const deliveredAt = Number(dj.deliveredAt), disputedAt = Number(dj.disputedAt);
    const reviewEndsAt = deliveredAt ? deliveredAt + dj.reviewPeriod : 0, evidenceEndsAt = disputedAt ? disputedAt + dj.evidencePeriod : 0, decideBy = disputedAt ? disputedAt + dj.decisionPeriod : 0;
    const is = (r: string) => roles.includes(r), live = dj.status === "delivered" || dj.status === "disputed";
    return {
      disputeId: did, escrowJobId: dj.escrowJobId.toString(), escrow: getAddress(d.address), status: dj.status as DisputeJobView["status"], outcome: dj.outcome,
      client: getAddress(dj.client), provider: getAddress(dj.provider), payee: getAddress(dj.payee), decider: getAddress(dj.decider), price: dj.price.toString(), priceText: `${fmt(dj.price)} ${S()}`,
      terms: { deciderMay: { pay: !!(dj.deciderMay & DISPUTE.MAY_PAY_PROVIDER), refund: !!(dj.deciderMay & DISPUTE.MAY_REFUND_CLIENT), split: !!(dj.deciderMay & DISPUTE.MAY_SPLIT) }, reviewSeconds: dj.reviewPeriod, evidenceSeconds: dj.evidencePeriod, decisionSeconds: dj.decisionPeriod, reviewTimeoutBps: dj.reviewTimeoutBps, decisionTimeoutBps: dj.decisionTimeoutBps, termsHash: String(dj.termsHash).toLowerCase() as Hex },
      deliveredAt, reviewEndsAt, disputedAt, evidenceEndsAt, decideBy, closedAt: Number(dj.closedAt), toProvider: dj.toProvider.toString(), toClient: dj.toClient.toString(),
      reason: disp[0] ? { hash: String(disp[0].args.reasonHash).toLowerCase() as Hex, tx: disp[0].transactionHash as Hex } : null,
      evidence: evid.map((e) => ({ by: getAddress(e.args.by) === getAddress(dj.client) ? ("client" as const) : ("provider" as const), hash: String(e.args.evidenceHash).toLowerCase() as Hex, tx: e.transactionHash as Hex })),
      now, canAccept: live && is("client"), canDispute: dj.status === "delivered" && is("client") && now <= reviewEndsAt,
      canAddEvidence: dj.status === "disputed" && (is("client") || is("provider")) && now <= evidenceEndsAt,
      canDecide: dj.status === "disputed" && is("decider") && now > evidenceEndsAt && now <= decideBy,
      canFinish: (dj.status === "delivered" && now > reviewEndsAt) || (dj.status === "disputed" && now > decideBy),
      canReclaim: false,
    };
  }

  // ───────────── reads ─────────────
  /** Every escrow job this workspace is a party to (client, provider, payee or decider), newest first; optionally one quote's. */
  async function jobs(quoteHash?: string | null): Promise<EscrowJobView[]> {
    rail.host.requireReady();
    owner();
    if (quoteHash != null && !HEX32.test(quoteHash)) throw new RailError("invalid_query", "quoteHash is 0x followed by 64 hexadecimal characters.", 422);
    const ev = (eventName: string, args: Record<string, unknown>) => rail.pub.getContractEvents({ address: E(), abi: A().ProofEscrowAbi, eventName, args, fromBlock: 0n }) as Promise<any[]>;
    const acct = getAddress(rail.a.ownerAccount!), vault = getAddress(rail.a.vault);
    const [asClient, asProvider, toVault] = await Promise.all([ev("JobOpened", { client: acct }), ev("JobOpened", { provider: acct }), ev("JobSettled", { payee: vault })]);
    const ids = new Set<string>([...asClient, ...asProvider, ...toVault].map((e) => e.args.jobId.toString()));
    // through the dispute escrow: the client, the provider's vault and the decider are in its terms, not in the proof escrow's
    const d = D();
    if (d) for (const e of (await rail.pub.getContractEvents({ address: d.address, abi: d.abi, eventName: "JobOpened", fromBlock: BigInt(d.deployBlock) } as never)) as any[]) if ([e.args.client, e.args.decider].some((a: string) => getAddress(a) === acct) || getAddress(e.args.payee) === vault) ids.add(e.args.escrowJobId.toString());
    const out: EscrowJobView[] = [];
    for (const id of ids) {
      const v = await jobView(id);
      if (!quoteHash || v.quoteHash === quoteHash.toLowerCase()) out.push(v);
    }
    return out.sort((a, b) => Number(b.jobId) - Number(a.jobId));
  }
  async function job(id: unknown): Promise<EscrowJobView> {
    rail.host.requireReady();
    owner();
    await partyJob(id);
    return jobView(String(id));
  }
  async function jobView(id: string): Promise<EscrowJobView> {
    const { j, roles } = await partyJob(id);
    const ev = async (eventName: string) => ((await rail.pub.getContractEvents({ address: E(), abi: A().ProofEscrowAbi, eventName, args: { jobId: BigInt(id) }, fromBlock: 0n })) as any[])[0] ?? null;
    const [o, s, r, latest] = await Promise.all([ev("JobOpened"), ev("JobSettled"), ev("JobRefunded"), rail.pub.getBlockNumber({ cacheTime: 0 }) as Promise<bigint>]);
    const now = await rail.chainNow();
    const at = (x: any) => (x ? { tx: x.transactionHash as Hex, block: x.blockNumber.toString() } : null);
    const dispute = j.disputeId ? await disputeView(j.disputeId, roles) : null;
    if (dispute) dispute.canReclaim = dispute.status === "funded" && (j.status === "refunded" || (j.status === "open" && now > j.deliverBy));
    return {
      jobId: id, status: j.status as EscrowJobView["status"], roles, client: getAddress(j.client), provider: getAddress(j.provider), payee: getAddress(j.payee), token: getAddress(j.token), price: j.price.toString(), priceText: `${fmt(j.price)} ${getAddress(j.token) === getAddress(rail.a.asset!) ? S() : "units of another token"}`,
      verifier: getAddress(j.verifier), specHash: String(j.specHash).toLowerCase() as Hex, deliverBy: j.deliverBy.toString(), deliverByTime: new Date(Number(j.deliverBy) * 1000).toISOString(),
      quoteHash: String(j.quoteHash).toLowerCase() as Hex, solutionHash: isZero(j.solutionHash) ? null : (String(j.solutionHash).toLowerCase() as Hex), resultDigest: isZero(j.resultDigest) ? null : (String(j.resultDigest).toLowerCase() as Hex),
      refundable: dispute ? dispute.canReclaim : j.status === "open" && now > j.deliverBy,
      opened: at(o), settled: s ? { ...at(s)!, confirmations: Number(latest - s.blockNumber + 1n) } : null, refunded: at(r),
      authority: roles.includes("payee") ? (dispute ? { status: "not-earnings", credit: "0", creditText: `0.00 ${S()}`, confirmations: 0, needed: rail.host.d7ConfigOf(rail.id)?.confirmations ?? 2, why: "Paid through the dispute escrow: the authority budget (R7 D7) counts only the proof escrow's own settlements into this vault, so this work adds nothing to it." } : await authorityOf(id, j.status)) : null,
      dispute,
    };
  }
  /** What one settlement does to this workspace's authority budget: the co-signer's rule, over the chain's events, with the same configuration. */
  async function authorityOf(id: string, status: string): Promise<NonNullable<EscrowJobView["authority"]>> {
    // D-K1b: the caps the co-signer applies: the operator's, lowered by the owner's signed caps in force
    const base = rail.host.d7ConfigOf(rail.id);
    const cfg = base && rail.authorityRule === "d7" ? withOwnerCaps(base, (await rail.cosigner.earnedCaps(Number(await rail.chainNow()) * 1000).catch(() => null))?.owner) : base;
    const none = (why: string) => ({ status: "not-settled" as const, credit: "0", creditText: `0.00 ${S()}`, confirmations: 0, needed: cfg?.confirmations ?? 2, why });
    if (!cfg || rail.authorityRule !== "d7") return none("This workspace's co-signer applies the release's rule, not the authority budget.");
    if (status !== "settled") return none(status === "refunded" ? "Refunded: nothing was paid, so nothing is earned." : "Not settled yet: nothing is earned before the verifier accepts a certificate and the escrow pays.");
    const { logs, latestBlock } = await readAuthorityLogs(rail.pub, cfg, { vault: A().QEDVaultAbi, execution: A().QEDExecutionAbi, escrow: A().ProofEscrowAbi }, BigInt(rail.a.deployBlock));
    const l = buildLedger(cfg, eventsFromLogs(cfg, logs), { latestBlock, grants: [], reservations: [], now: await rail.chainNow(), epoch: 0n });
    const key = `job:${id}`;
    const settledAt = logs.jobsSettled.find((x) => x.args.jobId.toString() === id);
    const confirmations = settledAt ? Number(latestBlock - settledAt.blockNumber + 1n) : 0;
    const not = l.notEarnings.find((x) => x.jobId === key);
    if (not) return { status: "not-earnings", credit: "0", creditText: `0.00 ${S()}`, confirmations, needed: cfg.confirmations, why: `Not earnings: ${not.why}.` };
    if (l.pendingCredits.some((x) => x.jobId === key)) return { status: "pending", credit: "0", creditText: `0.00 ${S()}`, confirmations, needed: cfg.confirmations, why: `Settled with ${confirmations} confirmation${confirmations === 1 ? "" : "s"}; the budget counts it after ${cfg.confirmations}.` };
    const entry = l.rule.log.find((x) => x.kind === "credit" && x.opId === key);
    const credit = entry ? entry.deltaBudget : 0n;
    // K1: what netting and the caps kept from this settlement, and the cap itself, wherever the figure is shown
    const k = l.earnedCredits.find((x) => x.id === key), u = (x: bigint) => `${units(x, cfg.decimals)} ${S()}`;
    const kept = !k ? "" : [
      k.netted > 0n ? ` ${u(k.netted)} of the price was set against money this workspace had sent this client before, so only ${u(k.countable)} counted.` : "",
      k.heldBy ? ` The cap held back ${u(k.uncapped - k.credit)}: ${k.heldBy === "window" ? "the workspace had already earned up to its limit for the window" : "the workspace had already earned up to its limit from this client for the window"}.` : "",
    ].join("");
    const cap = ` By rule, ${earnedCapWords(cfg, l.earnedCap)}.`;
    return { status: credit > 0n ? "credited" : "not-earnings", credit: credit.toString(), creditText: `${units(credit, cfg.decimals)} ${S()}`, confirmations, needed: cfg.confirmations, why: credit > 0n ? `Earned: half the price, from a client this workspace does not know to be its own (it shares no member or key with it).${kept}${cap} The rail cannot tell whether the same person runs another account or an address outside QED (D7 assumption A-ID); the cap is what bounds that.` : `Not counted by the authority budget.${kept}${cap}` };
  }

  /** What the wallet shows before asking for a quote: the problems a quote may name, with their certified answer. */
  function preview(raw: unknown) {
    owner();
    const { problem, spec, specBytes } = problemOf(raw);
    const c = certificate(spec);
    return { problem, specHash: keccak256(specBytes).toLowerCase(), certified: c.report.ok, weights: c.sol.w.map((w: bigint, i: number) => ({ asset: problem.assets[i]?.name ?? `asset ${i + 1}`, weight: pct(w) })), variance: c.report.variance.toString() };
  }

  return { jobs, job, refundParams, finishParams, preview, problemOf };
}

