/**
 * Refutation bounties on the local chain, with a claim path that pays only the committed finder (R11 section 9,
 * R10-008, R10-009). Local Anvil only: nothing here touches Sepolia, the release, or any public network.
 *
 * The release's two original 1,000-tUSD bounties, OptimalityBounty and MaximalityBounty, pay their whole balance to
 * msg.sender of the first valid claim, so a copied pending claim pays the copier (EV-077). On this chain the same
 * contracts, unmodified and built from the release's embedded bytecode, are the JUDGES of a QEDBountyBoard
 * (chain/bounties/src/QEDBountyBoard.sol) that holds each pool and pays only through commit, reveal and settle:
 *
 *   host (ensureBountyBoard)  deploys the board once per shared chain from chain/bounties/artifacts/QEDBountyBoard.json,
 *                             one dedicated judge per bounty (OptimalityBounty over the market's MinVarianceVerifier,
 *                             MaximalityBounty), opens each and funds it with 1,000 tUSD, the original pools' size.
 *                             (R13) The judges are deployed first and the board allows exactly their runtime code hashes
 *                             from its construction: a judge that keeps the pool would strand a bounty's money, so the
 *                             board opens no other. On a board recorded earlier with the allowlist, a judge added later
 *                             is allowed by this host's deployer key first; a board recorded before R13 has no list.
 *                             Recorded in the host's meta "bounties" only after the chain state is checkpointed.
 *                             With QED_RAIL_BOUNTY_CONTROLS=1 (TESTS ONLY) it also opens the release's positive
 *                             controls, labelled as such, whose judges can be refuted, so that a test can show a real
 *                             payout through the same served path.
 *   workspace (installBounties)
 *     check          is this claim a refutation? The judge answers through eth_call from the board's address (it holds
 *                    nothing, so a valid claim pays 0); nothing is recorded or sent.
 *     bounty-commit  the claim is checked as above (a rejected one is refused with the judge's own error), then the
 *                    workspace's claimant key (HKDF from this installation's secret, label
 *                    workspace:<id>:bounty-claimant) records the EIP-712 commitment over the bounty id, itself, the
 *                    recipient (by default the workspace's tUSD reserve vault), the claim's exact calldata and a
 *                    random salt, under the board's domain (chain id, board address). The digest is computed here and
 *                    by the board, and must agree before anything is sent. The salt stays in this workspace's store.
 *     bounty-reveal  once the commitment is old enough and before it expires; simulated first, so a reveal the board
 *                    would refuse (too early, expired, an older commitment leads, the contest has closed) is refused
 *                    here with nothing sent.
 *     bounty-settle  anyone may, once the contest has closed: the board pays the winner's recipient.
 *     advance        on the host's heartbeat (QED_RAIL_BOUNTY_AUTO, on by default): reveals this workspace's claims as
 *                    soon as they may be revealed, and settles its winning ones once the contest has closed, each as a
 *                    job under a fixed idempotency key, so the finder's protection does not depend on a screen being
 *                    open.
 */
import { randomBytes } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { decodeErrorResult, encodeAbiParameters, encodeFunctionData, getAddress, hashTypedData, keccak256, parseEther, parseEventLogs, toFunctionSelector, toHex, type Abi, type Address, type Hex, type LocalAccount } from "viem";
import type { OpResult } from "../types.ts";
import { CHAIN_DIR, CHAIN_ID, type RailConfig } from "./config.ts";
import type { MarketAddresses } from "./deploy.ts";
import { RailError } from "./errors.ts";
import type { Ctx, RailService } from "./service.ts";
import type { Store } from "./store.ts";
import type { Vendored } from "./vendored.ts";

export const BOARD_ARTIFACT = join(CHAIN_DIR, "bounties", "artifacts", "QEDBountyBoard.json");
export const CONTROLS_ARTIFACT = join(CHAIN_DIR, "bounties", "artifacts", "PositiveControls.json");
/** 1,000 tUSD in micro-units: the size of each original pool on Sepolia (B1, B2; TestUSD has 6 decimals). */
export const BOUNTY_POOL = 1_000_000_000n;
export const EIP712_NAME = "QED Bounty Board";
export const EIP712_VERSION = "1";
export const CLAIM_TYPES = {
  Claim: [
    { name: "bountyId", type: "uint256" },
    { name: "claimant", type: "address" },
    { name: "recipient", type: "address" },
    { name: "claim", type: "bytes" },
    { name: "salt", type: "bytes32" },
  ],
} as const;
/** The largest claim accepted, in bytes of calldata: MaximalityBounty's bounds (128 debts, 64 members) need about 33 KB. */
export const MAX_CLAIM_BYTES = 49_152;
export type BountyPhase = "none" | "open" | "contest" | "settleable" | "settled";
const ZERO = "0x0000000000000000000000000000000000000000" as Address;
type Rpc = (method: string, params?: unknown[]) => Promise<unknown>;

export type BountyKey = "optimality" | "maximality" | "optimality-control" | "maximality-control";
export interface BountyEntry {
  /** The bounty's id on the board (decimal). */
  id: string;
  key: BountyKey;
  /** Which claim shape the judge takes: OptimalityBounty.claim or MaximalityBounty.claim. */
  kind: "optimality" | "maximality";
  role: "original" | "positive-control";
  judge: Address;
  title: string;
}
export interface BountyBoardRecord {
  board: Address;
  token: Address;
  chainId: number;
  deployBlock: string;
  artifact: { bytecodeSha256: string; sourceSha256: string };
  pool: string;
  bounties: BountyEntry[];
  at: string;
}

const DEFS: { key: BountyKey; kind: BountyEntry["kind"]; role: BountyEntry["role"]; title: string }[] = [
  { key: "optimality", kind: "optimality", role: "original", title: "OptimalityBounty: money on Theorem 4.4, the optimality bound of a certified minimum-variance portfolio" },
  { key: "maximality", kind: "maximality", role: "original", title: "MaximalityBounty: money on weak LP duality, the maximality of a certified netting" },
  { key: "optimality-control", kind: "optimality", role: "positive-control", title: "Positive control (tests only): the release's OptimalityBounty over a verifier that accepts anything" },
  { key: "maximality-control", kind: "maximality", role: "positive-control", title: "Positive control (tests only): the release's netting rule that under-reports by 7 tUSD" },
];

// ───────────────────────────── artifacts ─────────────────────────────

export interface BoardArtifact { abi: Abi; bytecode: Hex; bytecodeSha256: string; sourceSha256: string }
export function loadBoardArtifact(path = BOARD_ARTIFACT): BoardArtifact {
  if (!existsSync(path)) throw new Error(`The bounty board's build (${path}) is missing: run scripts/export-artifacts.mjs in chain/bounties.`);
  const a = JSON.parse(readFileSync(path, "utf8"));
  if (!Array.isArray(a.abi) || typeof a.bytecode !== "string" || !/^0x[0-9a-fA-F]{100,}$/.test(a.bytecode)) throw new Error("The bounty board's build has no ABI or bytecode.");
  return { abi: a.abi, bytecode: a.bytecode, bytecodeSha256: a.bytecodeSha256, sourceSha256: a.sourceSha256 };
}
function loadControls(path = CONTROLS_ARTIFACT): Record<"AcceptAnything" | "UnsoundMaximality", { abi: Abi; bytecode: Hex }> {
  if (!existsSync(path)) throw new Error(`The positive controls' build (${path}) is missing.`);
  return JSON.parse(readFileSync(path, "utf8")).contracts;
}

/** The commitment a claimant records: the EIP-712 digest the board computes (QEDBountyBoard.commitmentOf). */
export function commitmentDigest(board: Address, chainId: number, f: { bountyId: bigint; claimant: Address; recipient: Address; claim: Hex; salt: Hex }): Hex {
  return hashTypedData({ domain: { name: EIP712_NAME, version: EIP712_VERSION, chainId, verifyingContract: board }, types: CLAIM_TYPES, primaryType: "Claim", message: f });
}

// ───────────────────────────── the host: deploy, open and fund, once ─────────────────────────────

export interface BoardDeps {
  c: any;
  v: Vendored;
  rpc: Rpc;
  store: Store;
  deployer: LocalAccount;
  market: MarketAddresses;
  cfg: RailConfig;
  iso: () => string;
  checkpoint: () => Promise<void>;
}

/**
 * Deploys the board and opens every bounty this configuration wants that the store does not record yet; returns the
 * record. Idempotent: a recorded board is reused (it must exist on the restored chain), and the record is written only
 * after the chain state holding it was checkpointed.
 */
export async function ensureBountyBoard(d: BoardDeps): Promise<BountyBoardRecord> {
  const art = loadBoardArtifact();
  const A = d.v.abi, fn = d.v.chain.fn, pub = d.c.pub, usd = d.market.usd;
  let rec = d.store.meta<BountyBoardRecord>("bounties");
  if (rec) {
    const code = await pub.getCode({ address: rec.board });
    if (!code || code.length <= 2) throw new Error("The store records a bounty board that the restored chain does not contain. Nothing was deployed over it.");
  }
  const wanted = DEFS.filter((x) => x.role === "original" || d.cfg.bounty.controls);
  const missing = wanted.filter((x) => !rec?.bounties.some((b) => b.key === x.key));
  if (rec && !missing.length) return rec;
  if ((await pub.getBalance({ address: d.deployer.address })) < parseEther("10")) await d.rpc("anvil_setBalance", [d.deployer.address, toHex(parseEther("1000"))]);
  const deploy = async (abi: unknown, bytecode: unknown, args: unknown[] = []) => getAddress((await d.c.deploy(d.deployer, abi, bytecode as Hex, args)).address);
  const controls = missing.some((x) => x.role === "positive-control") ? loadControls() : null;
  const p = d.cfg.bounty;
  const bounties = [...(rec?.bounties ?? [])];
  // R13: the judges first, so that the board can allow exactly their runtime code hashes (EXTCODEHASH)
  let acceptAnything: Address | null = null;
  const judges: { def: (typeof DEFS)[number]; judge: Address; codeHash: Hex }[] = [];
  for (const def of missing) {
    let judge: Address;
    if (def.key === "optimality") judge = await deploy(A.OptimalityBountyAbi, A.OptimalityBountyBytecode, [d.market.verifier, usd]);
    else if (def.key === "maximality") judge = await deploy(A.MaximalityBountyAbi, A.MaximalityBountyBytecode, [usd]);
    else if (def.key === "optimality-control") {
      acceptAnything ??= await deploy(controls!.AcceptAnything.abi, controls!.AcceptAnything.bytecode);
      judge = await deploy(A.OptimalityBountyAbi, A.OptimalityBountyBytecode, [acceptAnything, usd]);
    } else judge = await deploy(controls!.UnsoundMaximality.abi, controls!.UnsoundMaximality.bytecode, [usd]);
    judges.push({ def, judge, codeHash: keccak256((await pub.getCode({ address: judge }))!) });
  }
  const allowlist = boardTakesAllowlist(art.abi);
  // R13 review fix F7: each allowed judge with its own claim function (the board also checks the judge's own token)
  const allowed = [...new Map(judges.map((j) => [j.codeHash, { codeHash: j.codeHash, claimSelector: claimSelector(d.v, j.def.kind) }])).values()];
  const boardDeploy = rec ? null : await d.c.deploy(d.deployer, art.abi, art.bytecode, allowlist ? [allowed] : []);
  const board = rec?.board ?? getAddress(boardDeploy.address);
  const deployBlock = rec?.deployBlock ?? boardDeploy.blockNumber.toString();
  // a board recorded earlier: allow a judge it does not know yet (its deployer key is this host's); one from before R13 has no list
  if (rec && (await readsAllowlist(pub, board, art.abi))) {
    for (const j of allowed) {
      if (/^0x0{8}$/.test((await pub.readContract({ address: board, abi: art.abi, functionName: "judgeClaim", args: [j.codeHash] })) as string)) await d.c.send(d.deployer, board, encodeFunctionData({ abi: art.abi, functionName: "setJudge", args: [j.codeHash, j.claimSelector] }));
    }
  }
  for (const { def, judge } of judges) {
    const selector = claimSelector(d.v, def.kind);
    await d.c.send(d.deployer, board, encodeFunctionData({ abi: art.abi, functionName: "open", args: [judge, usd, selector, BigInt(p.revealDelaySeconds), BigInt(p.revealWindowSeconds), BigInt(p.contestSeconds)] }));
    const id = (await pub.readContract({ address: board, abi: art.abi, functionName: "bountyCount" })) as bigint;
    await d.c.send(d.deployer, usd, fn(A.TestUSDAbi, "mint", [d.deployer.address, BOUNTY_POOL])); // the host is tUSD's minter
    await d.c.send(d.deployer, usd, fn(A.TestUSDAbi, "approve", [board, BOUNTY_POOL]));
    await d.c.send(d.deployer, board, encodeFunctionData({ abi: art.abi, functionName: "fund", args: [id, BOUNTY_POOL] }));
    bounties.push({ id: id.toString(), key: def.key, kind: def.kind, role: def.role, judge, title: def.title });
  }
  rec = { board, token: usd, chainId: CHAIN_ID, deployBlock, artifact: { bytecodeSha256: art.bytecodeSha256, sourceSha256: art.sourceSha256 }, pool: BOUNTY_POOL.toString(), bounties, at: rec?.at ?? d.iso() };
  await d.checkpoint();
  d.store.setMeta("bounties", rec);
  return rec;
}

/** Whether a board build has the judge allowlist (R13; since the review fix F7 each judge with its claim function): its constructor takes the allowed judges. */
export function boardTakesAllowlist(abi: Abi): boolean {
  return abi.some((x) => x.type === "function" && (x as { name?: string }).name === "setJudge") && abi.some((x) => x.type === "constructor" && ((x as { inputs?: readonly unknown[] }).inputs?.length ?? 0) === 1);
}
/** Whether the board deployed at `board` answers judgeClaim (a board recorded before the review fix F7 does not). */
async function readsAllowlist(pub: BoardDeps["c"]["pub"], board: Address, abi: Abi): Promise<boolean> {
  if (!boardTakesAllowlist(abi)) return false;
  try { await pub.readContract({ address: board, abi, functionName: "judgeClaim", args: [`0x${"00".repeat(32)}`] }); return true; } catch { return false; }
}

function claimSelector(v: Vendored, kind: BountyEntry["kind"]): Hex {
  const abi = (kind === "optimality" ? v.abi.OptimalityBountyAbi : v.abi.MaximalityBountyAbi) as readonly { type: string; name?: string }[];
  const f = abi.find((x) => x.type === "function" && x.name === "claim");
  return toFunctionSelector(f as never);
}

// ───────────────────────────── a workspace's claims ─────────────────────────────

interface ClaimRecord {
  /** The commitment digest, which is also the claim's id in this workspace. */
  claimId: Hex;
  jobId: string;
  bountyId: string;
  key: BountyKey;
  board: Address;
  claimant: Address;
  recipient: Address;
  payTo: "reserve" | "owner-account";
  claimData: Hex;
  /** Secret until the reveal: with it and the claim, anyone could check the commitment. Never shown in a view. */
  salt: Hex;
  createdAt: string;
  committed?: { seq: string; at: number; revealableAt: number; expiresAt: number; tx: Hex };
  revealed?: { tx: Hex; at: string };
  settled?: { tx: Hex; payout: string; at: string };
  auto?: { reveal: number; settle: number };
}
const CLAIMS = "bounty:claims";
const MAX_CLAIMS = 64;
const HEX = /^0x[0-9a-fA-F]*$/, INT = /^-?\d{1,78}$/, UINT = /^\d{1,78}$/;
const bad = (m: string, details: Record<string, unknown> = {}) => new RailError("invalid_claim", m, 422, details);

/** The rail's host as this module needs it (host.ts adds these). */
interface BountyHost {
  bountyBoard: BountyBoardRecord | null;
  bountyStatus: { state: "off" | "ready" | "unavailable"; reason?: string };
  bountyClaimant(workspaceId: string): LocalAccount;
}

export function installBounties(rail: RailService) {
  const host = () => rail.host as unknown as BountyHost;
  const art = (): BoardArtifact => (cachedArt ??= loadBoardArtifact());
  let cachedArt: BoardArtifact | null = null;
  const boardRec = (): BountyBoardRecord => {
    const h = host();
    if (!h.bountyBoard) throw new RailError("bounties_unavailable", h.bountyStatus.reason ?? "The bounty board is not deployed on this chain.", 503);
    return h.bountyBoard;
  };
  const entryOf = (bountyId: unknown): BountyEntry => {
    const id = String(bountyId);
    const e = boardRec().bounties.find((b) => b.id === id);
    if (!e) throw new RailError("unknown_bounty", "Unknown bounty.", 404);
    return e;
  };
  const claimant = () => host().bountyClaimant(rail.id);
  const readBoard = (functionName: string, args: unknown[] = []) => rail.read(boardRec().board, art().abi, functionName, args) as Promise<any>;
  const records = (): ClaimRecord[] => rail.store.meta<ClaimRecord[]>(CLAIMS) ?? [];
  const save = (list: ClaimRecord[]) => rail.store.setMeta(CLAIMS, list);
  const update = (claimId: string, f: (r: ClaimRecord) => void) => { const list = records(); const r = list.find((x) => x.claimId === claimId); if (r) { f(r); save(list); } return r; };
  const recordOf = (claimId: unknown): ClaimRecord => {
    const r = typeof claimId === "string" ? records().find((x) => x.claimId === claimId.toLowerCase()) : undefined;
    if (!r) throw new RailError("unknown_claim", "Unknown claim in this workspace.", 404);
    return r;
  };
  const tusd = (raw: bigint | string) => rail.units(raw, 6);

  /**
   * A bounty as the board holds it. The phase is computed as QEDBountyBoard.phase() computes it, but against the rail's
   * clock (chainNow: the time the next transaction will carry), not the latest block's, which is stale on an idle chain.
   */
  async function bountyState(id: string) {
    const b = await readBoard("bounties", [BigInt(id)]);
    const [judge, revealDelay, token, revealWindow, winner, contestWindow, recipient, winnerSeq, selector, contestEndsAt, settled, pool, paid] = b as [Address, bigint, Address, bigint, Address, bigint, Address, bigint, Hex, bigint, boolean, bigint, bigint];
    const now = await rail.chainNow();
    const phase: BountyPhase = judge === ZERO ? "none" : settled ? "settled" : winner === ZERO ? "open" : now < contestEndsAt ? "contest" : "settleable";
    return { judge, token, selector, revealDelay: Number(revealDelay), revealWindow: Number(revealWindow), contestWindow: Number(contestWindow), winner, recipient, winnerSeq: winnerSeq.toString(), contestEndsAt: Number(contestEndsAt), settled, pool, paid, phase };
  }

  // ───────────── reading a claim and asking the judge ─────────────

  /** The judge's claim calldata from { calldata } or from the claim's structured fields. Shape only: the judge rules. */
  function encodeClaim(e: BountyEntry, raw: unknown): Hex {
    const o = raw as Record<string, unknown> | null;
    if (!o || typeof o !== "object" || Array.isArray(o)) throw bad("Send { claim: { calldata } } or the claim's fields (see the README).");
    const A = rail.v.abi;
    let data: Hex;
    if ("calldata" in o) {
      if (Object.keys(o).length !== 1 || typeof o.calldata !== "string" || !HEX.test(o.calldata) || o.calldata.length % 2) throw bad("calldata must be 0x-prefixed hex of whole bytes, alone.");
      data = o.calldata.toLowerCase() as Hex;
    } else if (e.kind === "optimality") {
      const spec = o.spec as Record<string, unknown>, cert = o.certificate as Record<string, unknown>;
      if (Object.keys(o).sort().join() !== "certificate,spec,x" || !spec || !cert) throw bad("An optimality claim is { spec: { n, cov, tol, universe? }, certificate: { w, nu, mu, L }, x }.");
      const n = Number(spec.n);
      if (!Number.isInteger(n) || n < 1 || n > 64) throw bad("spec.n must be a whole number (the verifier accepts 2 to 16).");
      const ints = (v: unknown, what: string, max: number) => { if (!Array.isArray(v) || v.length > max || v.some((x) => typeof x !== "string" || !INT.test(x))) throw bad(`${what} must be a list of at most ${max} integers written as decimal strings.`); return v.map((x) => BigInt(x as string)); };
      const one = (v: unknown, what: string, re: RegExp) => { if (typeof v !== "string" || !re.test(v)) throw bad(`${what} must be an integer written as a decimal string.`); return BigInt(v); };
      const universe = spec.universe === undefined ? `0x${"00".repeat(32)}` : spec.universe;
      if (typeof universe !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(universe)) throw bad("spec.universe, if given, is 32 bytes of hex.");
      const specBytes = encodeAbiParameters([{ type: "uint256" }, { type: "int256[]" }, { type: "uint256" }, { type: "bytes32" }], [BigInt(n), ints(spec.cov, "spec.cov", 4096), one(spec.tol, "spec.tol", UINT), universe as Hex]);
      const solution = encodeAbiParameters([{ type: "int256[]" }, { type: "int256" }, { type: "int256[]" }, { type: "int256[]" }], [ints(cert.w, "certificate.w", 64), one(cert.nu, "certificate.nu", INT), ints(cert.mu, "certificate.mu", 64), ints(cert.L, "certificate.L", 2080)]);
      data = encodeFunctionData({ abi: A.OptimalityBountyAbi as Abi, functionName: "claim", args: [specBytes, solution, ints(o.x, "x", 64)] });
    } else {
      const econ = o.economy as Record<string, unknown>, cert = o.certified as Record<string, unknown>;
      if (Object.keys(o).sort().join() !== "certified,economy,larger" || !econ || !cert) throw bad("A maximality claim is { economy: { members, debtor, creditor, d }, certified: { x, potential, y }, larger }.");
      const uints = (v: unknown, what: string) => { if (!Array.isArray(v) || v.length > 256 || v.some((x) => typeof x !== "string" || !UINT.test(x))) throw bad(`${what} must be a list of at most 256 whole numbers written as decimal strings.`); return v.map((x) => BigInt(x as string)); };
      const ints = (v: unknown, what: string) => { if (!Array.isArray(v) || v.length > 256 || v.some((x) => typeof x !== "string" || !INT.test(x))) throw bad(`${what} must be a list of at most 256 integers written as decimal strings.`); return v.map((x) => BigInt(x as string)); };
      if (typeof econ.members !== "string" || !UINT.test(econ.members)) throw bad("economy.members must be a whole number written as a decimal string.");
      const economy = { members: BigInt(econ.members), debtor: uints(econ.debtor, "economy.debtor"), creditor: uints(econ.creditor, "economy.creditor"), d: uints(econ.d, "economy.d") };
      const certified = { x: uints(cert.x, "certified.x"), potential: ints(cert.potential, "certified.potential"), y: uints(cert.y, "certified.y") };
      data = encodeFunctionData({ abi: A.MaximalityBountyAbi as Abi, functionName: "claim", args: [economy, certified, uints(o.larger, "larger")] });
    }
    if ((data.length - 2) / 2 > MAX_CLAIM_BYTES) throw bad(`A claim may be at most ${MAX_CLAIM_BYTES} bytes of calldata.`);
    if (data.slice(0, 10) !== claimSelector(rail.v, e.kind)) throw bad(`This bounty's judge takes ${e.kind === "optimality" ? "OptimalityBounty" : "MaximalityBounty"}.claim; the calldata names another function.`);
    return data;
  }

  /** Decodes a revert from the board or a judge (the release's errors), with the margin in plain words where it has one. */
  function decodeError(data: Hex | undefined, fallback: unknown, kind: BountyEntry["kind"]): { name: string; args: string[]; words: string } {
    let name = "UnknownRevert", args: unknown[] = [];
    if (data && data !== "0x") {
      try { const d = decodeErrorResult({ abi: art().abi, data }); name = d.errorName; args = [...(d.args ?? [])]; } catch {
        const r = rail.v.chain.decodeRevert({ data } as never); name = r.name; args = [...r.args];
      }
    } else { const r = rail.v.chain.decodeRevert(fallback); name = r.name; args = [...r.args]; }
    const s = args.map((x) => (typeof x === "bigint" ? x.toString() : String(x)));
    return { name, args: s, words: explain(name, s, kind) };
  }
  function explain(name: string, a: string[], kind: BountyEntry["kind"]): string {
    const scaled = (x: string) => { const v = BigInt(x); const neg = v < 0n; const m = neg ? -v : v; const W3 = 2n * 10n ** 54n; return `${neg ? "-" : ""}${(Number(m * 10n ** 12n / W3) / 1e12).toExponential(3)}`; };
    switch (name) {
      case "TheoremHolds":
        return kind === "optimality"
          ? `The theorem holds for this claim: the challenger's advantage over the certified portfolio is ${scaled(a[0])} in half-variance${a[0].startsWith("-") ? " (it is worse)" : ""}, and a refutation needs an advantage above the bound, ${scaled(a[1])}. Nothing would be paid.`
          : `The theorem holds for this claim: the certified netting cancels ${tusd(a[0])} tUSD and the challenger ${tusd(a[1])} tUSD, which is not more. Nothing would be paid.`;
      case "NotFeasible": return "The challenger portfolio is not feasible: it needs one non-negative weight per asset, summing to exactly 10^18.";
      case "NetPositionChanged": return `The larger netting changes member ${a[0]}'s net position by ${a[1]} micro-units, so it is not a valid netting.`;
      case "DualityGapTooLarge": return "The deployed verifier refuses this certificate (its duality gap is too large), so there is nothing to refute.";
      case "TooEarly": return `This commitment may be revealed from ${new Date(Number(a[0]) * 1000).toISOString()}.`;
      case "Expired": return `This commitment expired at ${new Date(Number(a[0]) * 1000).toISOString()}; commit again to claim.`;
      case "NotFirst": return "An older commitment leads: a claimant who committed earlier has revealed a valid claim.";
      case "ContestClosed": return "The contest has closed; the leading claim is paid at settlement.";
      case "ContestUnderway": return "A valid claim has been revealed; a commitment recorded now would be younger than it, so none is accepted until the bounty is settled.";
      case "AlreadySettled": case "BountyClosed": return "This bounty has been paid and is closed.";
      default: return `Refused: ${name}${a.length ? `(${a.join(", ")})` : ""}.`;
    }
  }

  /** Asks the judge through eth_call, from the board's address: nothing is recorded or sent. */
  async function precheck(e: BountyEntry, claimData: Hex): Promise<{ valid: true } | { valid: false; error: { name: string; args: string[]; words: string } }> {
    try {
      await rail.pub.call({ account: boardRec().board, to: e.judge, data: claimData, gas: 30_000_000n });
      return { valid: true };
    } catch (err) {
      const raw = (err as { walk?: (f: (x: any) => boolean) => any }).walk?.((x: any) => typeof x?.data === "string" && x.data.startsWith("0x"))?.data as Hex | undefined;
      return { valid: false, error: decodeError(raw, err, e.kind) };
    }
  }

  // ───────────── routes ─────────────

  /** POST /bounties/:bountyId/check */
  async function check(bountyId: unknown, body: any) {
    const e = entryOf(bountyId);
    const claimData = encodeClaim(e, body?.claim);
    const r = await precheck(e, claimData);
    return { bountyId: e.id, key: e.key, role: e.role, valid: r.valid, claimHash: keccak256(claimData), claimBytes: (claimData.length - 2) / 2, ...(r.valid ? { words: "The judge accepts this claim: it refutes the theorem. Commit it to claim the pool; nothing was recorded or sent." } : { error: r.error, words: r.error.words }) };
  }

  /** Validates POST /bounties/:bountyId/claims before anything is stored; refuses a claim the judge rejects. */
  async function commitParams(bountyId: unknown, body: any): Promise<{ bountyId: string; payTo: ClaimRecord["payTo"]; claimData: Hex }> {
    const e = entryOf(bountyId);
    if (body && typeof body === "object" && Object.keys(body).some((k) => k !== "claim" && k !== "payTo")) throw bad("A claim takes { claim, payTo? }.");
    const payTo = body?.payTo === undefined ? "reserve" : body.payTo;
    if (payTo !== "reserve" && payTo !== "owner-account") throw bad('payTo is "reserve" (the workspace\'s tUSD reserve vault, the default) or "owner-account".');
    const claimData = encodeClaim(e, body?.claim);
    const s = await bountyState(e.id);
    if (s.phase !== "open") throw new RailError("bounty_not_open", s.phase === "settled" ? "This bounty has been paid and is closed." : "A valid claim has already been revealed for this bounty; a commitment recorded now would be younger than it and could not win.", 409, { phase: s.phase });
    if (records().length >= MAX_CLAIMS) throw new RailError("too_many_claims", `This workspace holds ${MAX_CLAIMS} claims already.`, 409);
    const r = await precheck(e, claimData);
    if (!r.valid) throw new RailError("claim_rejected", `The judge rejects this claim, so it cannot be paid: ${r.error.words}`, 422, { error: r.error });
    return { bountyId: e.id, payTo, claimData };
  }
  const revealParams = (claimId: unknown) => ({ claimId: recordOf(claimId).claimId });
  const settleParams = (bountyId: unknown) => ({ bountyId: entryOf(bountyId).id });

  // ───────────── jobs ─────────────

  async function gas(a: Address) {
    if ((await rail.pub.getBalance({ address: a })) < parseEther("1")) await rail.rpc("anvil_setBalance", [a, toHex(parseEther("10"))]);
  }
  const step = (ctx: Ctx, key: string, label: string, status: "ok" | "refused" | "info", detail: string, data?: Record<string, unknown>) => ctx.push({ key, label, status, detail, ...(data ? { data } : {}) });
  const done = (ctx: Ctx, outcome: OpResult["outcome"], summary: string, tx?: any, evidence?: Record<string, unknown>): OpResult => {
    rail.record(ctx, { kind: "bounty", title: summary, outcome, tx: tx ? rail.txBrief(tx) : undefined });
    return { outcome, summary, ...(tx ? { tx: rail.txBrief(tx) } : {}), ...(evidence ? { evidence } : {}) };
  };
  const boardEvents = async (hash: Hex) => parseEventLogs({ abi: art().abi, logs: (await rail.pub.getTransactionReceipt({ hash })).logs }) as any[];

  rail.handlers.set("bounty-commit", async (ctx): Promise<OpResult> => {
    const { bountyId, payTo, claimData } = ctx.request as { bountyId: string; payTo: ClaimRecord["payTo"]; claimData: Hex };
    const e = entryOf(bountyId), b = boardRec(), who = claimant();
    const recipient = getAddress(payTo === "owner-account" ? rail.a.ownerAccount! : rail.a.reserve);
    // one record per job: a rerun after a restart reuses its salt and commitment instead of making new ones
    const kept = records().find((x) => x.jobId === ctx.jobId);
    let rec: ClaimRecord;
    if (kept) rec = kept;
    else {
      const salt = toHex(randomBytes(32));
      const claimId = commitmentDigest(b.board, CHAIN_ID, { bountyId: BigInt(e.id), claimant: who.address, recipient, claim: claimData, salt }).toLowerCase() as Hex;
      const onChain = ((await readBoard("commitmentOf", [BigInt(e.id), who.address, recipient, claimData, salt])) as Hex).toLowerCase();
      if (onChain !== claimId) throw new RailError("commitment_mismatch", "The board computes a different commitment than this service. Nothing was sent.", 500);
      rec = { claimId, jobId: ctx.jobId, bountyId: e.id, key: e.key, board: b.board, claimant: who.address, recipient, payTo, claimData, salt, createdAt: rail.iso() };
    }
    const drop = () => save(records().filter((x) => x.claimId !== rec.claimId));
    step(ctx, "commitment", "Commitment computed", "info", `EIP-712 digest over bounty ${e.id}, the claimant ${who.address}, the recipient ${recipient} (${payTo === "reserve" ? "this workspace's tUSD reserve vault" : "this workspace's owner account"}), the claim's ${(claimData.length - 2) / 2} bytes and a random salt, under the board's domain (chain ${CHAIN_ID}, ${b.board}). The board computes the same digest. The claim itself is not sent.`, { claimId: rec.claimId });
    let c = await readBoard("commitments", [who.address, rec.claimId]);
    let tx: any = null;
    if (BigInt(c[0]) === 0n) {
      const s = await bountyState(e.id);
      if (s.phase !== "open") { drop(); step(ctx, "commit", "Not committed", "refused", explain(s.phase === "settled" ? "BountyClosed" : "ContestUnderway", [], e.kind)); return done(ctx, "refused", `Bounty ${e.id} is ${s.phase}: nothing was committed.`); }
      if (!kept) save([...records(), rec]); // before sending: a restart after the broadcast finds the same salt
      await gas(who.address);
      try {
        tx = await rail.send(ctx, "bounty:commit", who, b.board, encodeFunctionData({ abi: art().abi, functionName: "commit", args: [BigInt(e.id), rec.claimId] }));
      } catch (err) {
        if (BigInt((await readBoard("commitments", [who.address, rec.claimId]))[0]) === 0n) drop(); // nothing reached the chain
        throw err;
      }
      c = await readBoard("commitments", [who.address, rec.claimId]);
    }
    const s = await bountyState(e.id);
    const at = Number(c[1]), revealableAt = at + s.revealDelay, expiresAt = revealableAt + s.revealWindow;
    update(rec.claimId, (r) => { r.committed = { seq: BigInt(c[0]).toString(), at, revealableAt, expiresAt, tx: (tx?.hash ?? r.committed?.tx ?? "0x") as Hex }; });
    const summary = `Committed a claim to bounty ${e.id} (${e.title.split(":")[0]}): commitment #${BigInt(c[0])} by ${who.address}. It may be revealed from ${new Date(revealableAt * 1000).toISOString()} until ${new Date(expiresAt * 1000).toISOString()}; the claim stays private until then.`;
    step(ctx, "commit", "QEDBountyBoard.commit mined", "ok", summary, tx ? rail.txData(tx) : { recovered: true });
    return done(ctx, "executed", summary, tx, { claimId: rec.claimId, bountyId: e.id, seq: BigInt(c[0]).toString(), committedAt: at, revealableAt, expiresAt, claimant: who.address, recipient });
  });
  rail.rerunnable.add("bounty-commit"); // each step checks the chain first

  rail.handlers.set("bounty-reveal", async (ctx): Promise<OpResult> => {
    const rec = recordOf(ctx.request.claimId), e = entryOf(rec.bountyId), who = claimant();
    const c = await readBoard("commitments", [who.address, rec.claimId]);
    if (BigInt(c[0]) === 0n) { step(ctx, "reveal", "Not committed", "refused", "This claim's commitment is not on the chain."); return done(ctx, "refused", "Nothing to reveal: the commitment is not on the chain."); }
    if (c[3]) { step(ctx, "reveal", "Already revealed", "info", "This commitment was revealed before; a commitment is revealed at most once."); return done(ctx, "no-action", "Already revealed; nothing was sent."); }
    ctx.clock = await rail.align();
    const data = encodeFunctionData({ abi: art().abi, functionName: "reveal", args: [BigInt(e.id), rec.recipient, rec.claimData, rec.salt] });
    try {
      await rail.pub.call({ account: who.address, to: rec.board, data, gas: 30_000_000n, blockTag: "pending" });
    } catch (err) {
      const raw = (err as any).walk?.((x: any) => typeof x?.data === "string" && x.data.startsWith("0x"))?.data as Hex | undefined;
      const why = decodeError(raw, err, e.kind);
      step(ctx, "reveal", `Not revealed: ${why.name}`, "refused", `${why.words} Nothing was sent, so the claim stays private.`, { error: why });
      return done(ctx, "refused", `The reveal of claim ${rec.claimId.slice(0, 10)}… was refused before sending: ${why.words}`, undefined, { error: why });
    }
    await gas(who.address);
    const tx = await rail.send(ctx, "bounty:reveal", who, rec.board, data);
    const ev = (await boardEvents(tx.hash)).find((x) => x.eventName === "Revealed");
    const s = await bountyState(e.id);
    update(rec.claimId, (r) => { r.revealed = { tx: tx.hash, at: rail.iso() }; });
    const took = ev && getAddress(ev.args.replaced) !== ZERO;
    const summary = `Revealed claim ${rec.claimId.slice(0, 10)}… on bounty ${e.id}: the judge accepted it and this workspace's claimant leads${took ? `, taking over from ${ev.args.replaced} (whose commitment is younger)` : ""}. The pool (${tusd(s.pool)} tUSD) goes to ${rec.recipient} at settlement, from ${new Date(s.contestEndsAt * 1000).toISOString()}, unless an older commitment is revealed before then.`;
    step(ctx, "reveal", "QEDBountyBoard.reveal mined", "ok", summary, rail.txData(tx));
    return done(ctx, "executed", summary, tx, { claimId: rec.claimId, bountyId: e.id, contestEndsAt: s.contestEndsAt, replaced: took ? ev.args.replaced : null, pool: s.pool.toString() });
  });

  rail.handlers.set("bounty-settle", async (ctx): Promise<OpResult> => {
    const e = entryOf(ctx.request.bountyId), b = boardRec(), who = claimant();
    const s = await bountyState(e.id);
    if (s.phase === "settled") { step(ctx, "settle", "Already settled", "info", `Bounty ${e.id} paid ${tusd(s.paid)} tUSD to ${s.recipient}.`); return done(ctx, "no-action", `Bounty ${e.id} was already settled; nothing was sent.`); }
    if (s.phase !== "settleable") {
      const why = s.phase === "open" ? "No valid claim has been revealed." : `The contest is open until ${new Date(s.contestEndsAt * 1000).toISOString()}.`;
      step(ctx, "settle", "Not settleable yet", "refused", `${why} Nothing was sent.`);
      return done(ctx, "refused", `Bounty ${e.id} cannot be settled yet: ${why}`);
    }
    ctx.clock = await rail.align();
    await gas(who.address);
    const tx = await rail.send(ctx, "bounty:settle", who, b.board, encodeFunctionData({ abi: art().abi, functionName: "settle", args: [BigInt(e.id)] }));
    const ev = (await boardEvents(tx.hash)).find((x) => x.eventName === "Settled");
    const payout = BigInt(ev?.args.payout ?? 0n), to = getAddress(ev?.args.recipient ?? s.recipient);
    for (const r of records().filter((x) => x.bountyId === e.id && x.revealed)) update(r.claimId, (x) => { x.settled = { tx: tx.hash, payout: payout.toString(), at: rail.iso() }; });
    const ours = records().some((r) => r.bountyId === e.id && getAddress(r.recipient) === to && getAddress(r.claimant) === getAddress(ev?.args.winner ?? s.winner));
    const summary = `Settled bounty ${e.id}: the board paid ${tusd(payout)} tUSD to ${to}${ours ? ", this workspace's recipient" : ", the winning claimant's recipient"}. Anyone may settle; the board pays only the recorded recipient, once.`;
    step(ctx, "settle", "QEDBountyBoard.settle mined", "ok", summary, rail.txData(tx));
    return done(ctx, "executed", summary, tx, { bountyId: e.id, winner: ev?.args.winner ?? s.winner, recipient: to, payout: payout.toString(), ours });
  });
  // after a restart, a reveal or settlement that was running is resolved by looking its transaction up, never re-sent
  rail.recoverers.set("bounty-reveal", (job) => rail.lookupSent(job, "bounty:reveal", "bounty", "Revealed"));
  rail.recoverers.set("bounty-settle", (job) => rail.lookupSent(job, "bounty:settle", "bounty", "Settled"));

  // ───────────── views ─────────────

  /** GET /bounties (host route): the board and every bounty on it, read from the chain. */
  async function board() {
    const h = host();
    if (!h.bountyBoard) return { status: h.bountyStatus.state, reason: h.bountyStatus.reason ?? null, board: null, bounties: [] };
    const b = h.bountyBoard;
    const bounties = [];
    for (const e of b.bounties) {
      const s = await bountyState(e.id);
      bounties.push({ ...e, phase: s.phase, pool: s.pool.toString(), poolText: `${tusd(s.pool)} tUSD`, paid: s.paid.toString(), winner: s.winner === ZERO ? null : s.winner, recipient: s.phase === "open" ? null : s.recipient, contestEndsAt: s.contestEndsAt || null, periods: { revealDelaySeconds: s.revealDelay, revealWindowSeconds: s.revealWindow, contestSeconds: s.contestWindow }, selector: s.selector });
    }
    // auto: whether the heartbeat reveals this workspace's claims when due and settles its winning ones (QED_RAIL_BOUNTY_AUTO)
    return { status: "ready", auto: rail.cfg.bounty.auto, board: b.board, chainId: b.chainId, token: b.token, tokenSymbol: "tUSD", domain: { name: EIP712_NAME, version: EIP712_VERSION, chainId: b.chainId, verifyingContract: b.board, separator: await readBoard("domainSeparator") }, claimType: "Claim(uint256 bountyId,address claimant,address recipient,bytes claim,bytes32 salt)", deployBlock: b.deployBlock, artifact: b.artifact, bounties };
  }

  /** GET /bounties/claims: this workspace's claims, each with its state read from the chain. The salt is never shown. */
  async function claims() {
    boardRec();
    const now = Number(await rail.chainNow()), who = claimant(), zero = ZERO;
    const out = [];
    for (const r of records().slice().reverse()) {
      const c = await readBoard("commitments", [r.claimant, r.claimId]);
      const s = await bountyState(r.bountyId);
      const seq = BigInt(c[0]).toString(), revealed = Boolean(c[3]);
      const leading = s.winner !== zero && getAddress(s.winner) === getAddress(r.claimant) && s.winnerSeq === seq;
      out.push({ ...summaryOf(r, s, seq, revealed, leading, now), claimId: r.claimId, bountyId: r.bountyId, key: r.key, claimant: r.claimant, recipient: r.recipient, payTo: r.payTo, claimHash: keccak256(r.claimData), claimBytes: (r.claimData.length - 2) / 2, seq, committed: r.committed ?? null, revealed: r.revealed ?? null, settled: r.settled ?? null, contestEndsAt: s.contestEndsAt || null, createdAt: r.createdAt });
    }
    return { claimant: who.address, recipients: { reserve: rail.a.reserve, ownerAccount: rail.a.ownerAccount ?? null }, claims: out };
  }

  /**
   * A claim's state, from the chain: committing (no commitment on chain yet), committed (not revealable yet),
   * revealable, leading, overtaken (an older commitment took over), won, lost, expired (never revealed in its window),
   * too-late (never revealed, and it can no longer win: the bounty was settled, its contest closed, or a commitment
   * older than it leads).
   */
  function summaryOf(r: ClaimRecord, s: Awaited<ReturnType<typeof bountyState>>, seq: string, revealed: boolean, leading: boolean, now: number) {
    let state: string;
    if (seq === "0") state = "committing";
    else if (revealed) state = s.settled ? (leading ? "won" : "lost") : leading ? "leading" : "overtaken";
    else if (r.committed && now >= r.committed.expiresAt) state = "expired";
    else if (!canStillWin(s, seq)) state = "too-late";
    else state = r.committed && now >= r.committed.revealableAt ? "revealable" : "committed";
    return { state, paid: state === "won" ? s.paid.toString() : null, paidText: state === "won" ? `${tusd(s.paid)} tUSD` : null };
  }
  /** An unrevealed commitment can still win while the bounty is open, or during its contest if it is older than the leader's. */
  const canStillWin = (s: Awaited<ReturnType<typeof bountyState>>, seq: string) => s.phase === "open" || (s.phase === "contest" && BigInt(seq) < BigInt(s.winnerSeq));


  /**
   * On the host's heartbeat: reveal this workspace's claims as soon as they may be revealed, and settle its winning
   * ones once the contest has closed. Each is a job under a fixed idempotency key (with an attempt number that moves on
   * only after a refused attempt, at most three times), so a heartbeat never starts the same step twice.
   */
  async function advance(): Promise<void> {
    if (!host().bountyBoard || !rail.cfg.bounty.auto) return;
    const pending = records().filter((r) => r.committed && !r.settled);
    if (!pending.length) return;
    const now = Number(await rail.chainNow());
    const finished = (status: string) => status === "done" || status === "failed" || status === "interrupted";
    for (const r of pending) {
      try {
        const tries = r.auto ?? { reveal: 0, settle: 0 };
        if (!r.revealed && now >= r.committed!.revealableAt && now < r.committed!.expiresAt && tries.reveal < 3) {
          if (!canStillWin(await bountyState(r.bountyId), r.committed!.seq)) continue;
          const a = rail.submit("bounty-reveal", { claimId: r.claimId }, `bounty-auto:${r.claimId.slice(2, 18)}:reveal:${tries.reveal}`);
          // an earlier attempt under this key finished without revealing: the next heartbeat uses the next key
          if (a.duplicate && finished(a.status)) update(r.claimId, (x) => { if (!x.revealed) x.auto = { ...tries, reveal: tries.reveal + 1 }; });
        } else if (r.revealed && tries.settle < 3) {
          const s = await bountyState(r.bountyId);
          if (s.phase !== "settleable" || getAddress(s.winner) !== getAddress(r.claimant)) continue;
          const a = rail.submit("bounty-settle", { bountyId: r.bountyId }, `bounty-auto:${r.claimId.slice(2, 18)}:settle:${tries.settle}`);
          if (a.duplicate && finished(a.status)) update(r.claimId, (x) => { if (!x.settled) x.auto = { ...tries, settle: tries.settle + 1 }; });
        }
      } catch {
        /* busy, out of budget or unreachable: the next heartbeat tries again */
      }
    }
  }

  return { board, claims, check, commitParams, revealParams, settleParams, advance, encodeClaim };
}
