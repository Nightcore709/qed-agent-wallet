/**
 * What moved in and out of one workspace's wallet on the chain, for the wallet's double-entry books (R13, RISK-084).
 * A read: nothing is signed or sent.
 *
 * A movement is one log of the chain, named by its transaction hash and log index:
 *   - every ERC-20 Transfer of the workspace's two tokens (the treasury's asset, tINR, and the reserve's, tUSD) into or out
 *     of one of its three holders: the treasury vault, the reserve vault and the owner account. A transfer between two of
 *     them is one movement with both sides the workspace's own.
 *   - for escrow work this workspace commissioned (it is the job's client), the escrow's JobSettled log: the escrow pays the
 *     provider and nothing of this workspace's moves, but the money it funded is now spent rather than held.
 * Movements this workspace sent and movements it only observes (an escrow paying it, a refund, the faucet's opening grant,
 * a transfer from outside) are listed alike, because they are read from the chain's logs, not from what was asked.
 *
 * Each carries its block (number, hash, time) and its confirmations against the chain's latest block; the job of this
 * workspace that sent it, from the rail's own receipts; the counterparty named by what it is; and, for a conversion, every
 * pool hop of its transaction, read from the pool's own Swap and Sync logs (Sync is emitted with the reserves after the
 * swap, just before Swap), with the pool's fee as the pool itself states it. The wallet's books decide what counts and how
 * it is booked (server/chain-books.ts); this file only reports what the chain holds.
 *
 * `blocks` asks for the hash the chain now holds at given heights, so that the books can tell whether a block they booked
 * from is still part of the chain (a reorganisation, or a chain restored from an older state).
 */
import { getAddress, parseAbiItem, parseEventLogs, type Address, type Hex } from "viem";
import { CHAIN_ID } from "./config.ts";
import { RailError, type RailService } from "./service.ts";

const TRANSFER = parseAbiItem("event Transfer(address indexed from, address indexed to, uint256 value)");
const ZERO = "0x0000000000000000000000000000000000000000";
/** At most this many movements in one answer; a longer range is cut at a block boundary and `range.to` says where. */
export const MOVEMENTS_CAP = 2000;
/** At most this many heights in `blocks`. */
export const BLOCKS_CAP = 64;

export type HolderRole = "treasury" | "reserve" | "owner-account";
export type CounterpartyKind = "own" | "faucet" | "conversion" | "escrow" | "payee" | "bounty" | "workspace" | "outside";
export interface MovementHop { pool: Address; label: string; feeBps: number; tokenIn: Address; tokenOut: Address; amountIn: string; amountOut: string; reserveInBefore: string; reserveOutBefore: string }
export interface MovementView {
  txHash: Hex; logIndex: number; blockNumber: string; blockHash: Hex; blockTimestamp: number; confirmations: number;
  /** "transfer": a Transfer touching a holder. "escrow-settled": the escrow paid the provider of work this workspace commissioned. */
  kind: "transfer" | "escrow-settled";
  token: Address; symbol: string; decimals: number; amount: string;
  from: Address; to: Address; fromRole: HolderRole | null; toRole: HolderRole | null;
  counterparty: { address: Address; kind: CounterpartyKind; label: string | null };
  /** The job of this workspace whose transaction it is (the rail's own receipts), or null when another sent it. */
  jobId: string | null;
  escrow: { jobId: string; event: "opened" | "settled" | "refunded"; role: "client" | "provider" } | null;
  conversion: { hops: MovementHop[]; amountIn: string | null; spent: string | null; amountOut: string | null; tokenOut: Address | null } | null;
}
export interface MovementsView {
  network: string; chainId: number; genesisId: string | null;
  head: { number: string; hash: Hex; timestamp: number };
  range: { from: string; to: string; complete: boolean };
  finality: { kind: "confirmations"; depth: number; source: string };
  holders: { role: HolderRole; address: Address }[];
  tokens: { symbol: string; address: Address; decimals: number }[];
  movements: MovementView[];
  canonical: Record<string, Hex | null>;
}

const low = (a: string) => a.toLowerCase();
const num = (v: string | null, name: string): bigint | undefined => {
  if (v === null || v === "") return undefined;
  if (!/^\d{1,12}$/.test(v)) throw new RailError("invalid_query", `${name} must be a block number.`, 422);
  return BigInt(v);
};

export function installMovements(rail: RailService) {
  const poolInfo = new Map<string, { token0: Address; token1: Address; feeBps: number }>();
  async function pool(address: Address) {
    const k = low(address);
    let p = poolInfo.get(k);
    if (!p) {
      const A = rail.v.abi.CPMMPoolAbi;
      const [token0, token1, feeBps] = await Promise.all([rail.read(address, A, "token0"), rail.read(address, A, "token1"), rail.read(address, A, "feeBps")]) as [Address, Address, number | bigint];
      p = { token0: getAddress(token0), token1: getAddress(token1), feeBps: Number(feeBps) };
      poolInfo.set(k, p);
    }
    return p;
  }

  /** Parses ?fromBlock=, ?toBlock= and ?blocks=1,2,3 (each a block number). */
  function parseQuery(q: URLSearchParams): { fromBlock?: bigint; toBlock?: bigint; blocks: bigint[] } {
    const raw = q.get("blocks");
    const blocks = raw ? raw.split(",").map((s) => num(s.trim(), "blocks")!) : [];
    if (blocks.length > BLOCKS_CAP) throw new RailError("invalid_query", `Ask for at most ${BLOCKS_CAP} block hashes at a time.`, 422);
    return { fromBlock: num(q.get("fromBlock"), "fromBlock"), toBlock: num(q.get("toBlock"), "toBlock"), blocks };
  }

  async function read(q: URLSearchParams): Promise<MovementsView> {
    rail.host.requireReady();
    const m = rail.host.market;
    const owner = rail.a.ownerAccount;
    if (!m || !owner || !rail.a.asset || !rail.a.reserveAsset) throw new RailError("unsupported_read", "Movements are read for a workspace owned by a passkey account on the multi-tenant rail.", 422);
    const { fromBlock, toBlock, blocks } = parseQuery(q);
    const pub = rail.pub;
    const head = await pub.getBlock({ blockTag: "latest" });
    const from = fromBlock ?? BigInt(rail.a.deployBlock);
    let to = toBlock === undefined || toBlock > head.number ? head.number : toBlock;

    const holders: { role: HolderRole; address: Address }[] = [{ role: "treasury", address: getAddress(rail.a.vault) }, { role: "reserve", address: getAddress(rail.a.reserve) }, { role: "owner-account", address: getAddress(owner) }];
    const tokens = [{ symbol: rail.asset.symbol, address: getAddress(rail.a.asset), decimals: rail.asset.decimals }, { symbol: rail.reserveAsset.symbol, address: getAddress(rail.a.reserveAsset), decimals: rail.reserveAsset.decimals }];
    const roleOf = (a: string): HolderRole | null => holders.find((h) => low(h.address) === low(a))?.role ?? null;
    const tokenOf = (a: string) => tokens.find((t) => low(t.address) === low(a))!;
    const escrow = getAddress(m.escrow);
    // R13 E3: the dispute escrow in front of the proof escrow holds a job's money between verification and payout
    const D = rail.host.disputes;
    const ownAddrs = holders.map((h) => h.address);

    // the counterparty, named by what it is
    const conversion = new Set([rail.a.exec, ...rail.a.pools, ...(m.inrPools ?? []), ...(m.pools ?? [])].filter(Boolean).map(low));
    const payees = new Map<string, string>([[low(rail.K.CLOUDCO.address), "CloudCo"]]);
    const bounty = new Set([m.optimalityBounty, m.maximalityBounty, m.clearing, rail.host.bountyBoard?.board].filter(Boolean).map((x) => low(x as string)));
    const others = new Set(rail.host.all().filter((w) => w.id !== rail.id && w.a).flatMap((w) => [w.a.vault, w.a.reserve, w.a.ownerAccount].filter(Boolean).map((x) => low(x as string))));
    const counterpartyOf = (a: Address): MovementView["counterparty"] => {
      const k = low(a);
      if (k === ZERO) return { address: a, kind: "faucet", label: "The local chain's faucet" };
      if (roleOf(a)) return { address: a, kind: "own", label: null };
      if (conversion.has(k)) return { address: a, kind: "conversion", label: rail.venueLabel(a) };
      if (k === low(escrow)) return { address: a, kind: "escrow", label: "ProofEscrow" };
      if (D && k === low(D.address)) return { address: a, kind: "escrow", label: "QEDDisputeEscrow" };
      if (payees.has(k)) return { address: a, kind: "payee", label: payees.get(k)! };
      if (bounty.has(k)) return { address: a, kind: "bounty", label: null };
      if (others.has(k)) return { address: a, kind: "workspace", label: null };
      return { address: a, kind: "outside", label: null };
    };

    // the logs: transfers of the two tokens out of and into the holders; the escrow's settlements of this workspace's commissions
    const transfers = async (args: Record<string, unknown>) => (from > to ? [] : ((await pub.getLogs({ address: tokens.map((t) => t.address), event: TRANSFER, args, fromBlock: from, toBlock: to })) as any[]));
    const [outs, ins, commissioned, commissionedD] = await Promise.all([
      transfers({ from: ownAddrs }), transfers({ to: ownAddrs }),
      pub.getContractEvents({ address: escrow, abi: rail.v.abi.ProofEscrowAbi, eventName: "JobOpened", args: { client: getAddress(owner) }, fromBlock: 0n }) as Promise<any[]>,
      (D ? pub.getContractEvents({ address: D.address, abi: D.abi, eventName: "JobOpened", args: { client: getAddress(owner) }, fromBlock: 0n } as never) : Promise.resolve([])) as Promise<any[]>,
    ]);
    const asClient = new Map<string, any>(commissioned.map((e) => [e.args.jobId.toString(), e.args]));
    const settled = from > to || !asClient.size ? [] : ((await pub.getContractEvents({ address: escrow, abi: rail.v.abi.ProofEscrowAbi, eventName: "JobSettled", args: { jobId: [...asClient.keys()].map((x) => BigInt(x)) }, fromBlock: from, toBlock: to })) as any[]);
    // work commissioned through the dispute escrow: the provider's part of each payout, as the escrow paying for it
    const asClientD = new Map<string, any>(commissionedD.map((e) => [e.args.id.toString(), e.args]));
    const closedD = !D || from > to || !asClientD.size ? [] : ((await pub.getContractEvents({ address: D.address, abi: D.abi, eventName: "Closed", args: { id: [...asClientD.keys()].map((x) => BigInt(x)) }, fromBlock: from, toBlock: to } as never)) as any[]).filter((l) => BigInt(l.args.toProvider) > 0n);

    const seen = new Set<string>();
    type Found = { kind: "transfer" | "escrow-settled"; l: any; viaDispute?: true };
    let logs: Found[] = [...outs, ...ins].filter((l) => { const k = `${low(l.transactionHash)}:${l.logIndex}`; if (seen.has(k) || l.args.value === 0n) return false; seen.add(k); return true; })
      .map((l): Found => ({ kind: "transfer", l })).concat(settled.map((l): Found => ({ kind: "escrow-settled", l }))).concat(closedD.map((l): Found => ({ kind: "escrow-settled", l, viaDispute: true })))
      .sort((a, b) => (a.l.blockNumber === b.l.blockNumber ? a.l.logIndex - b.l.logIndex : a.l.blockNumber < b.l.blockNumber ? -1 : 1));
    // a long range is answered in parts, each ending at a whole block
    let complete = true;
    if (logs.length > MOVEMENTS_CAP) {
      const last = logs[MOVEMENTS_CAP - 1].l.blockNumber as bigint;
      const cut = logs.findIndex((x) => x.l.blockNumber >= last);
      to = cut > 0 ? last - 1n : last;
      logs = logs.filter((x) => x.l.blockNumber <= to);
      complete = false;
    }

    // each transaction once: its receipt's other logs say what the transfer was part of
    const blockCache = new Map<bigint, { hash: Hex; timestamp: number }>();
    const blockOf = async (n: bigint) => { let b = blockCache.get(n); if (!b) { const x = await pub.getBlock({ blockNumber: n }); b = { hash: x.hash as Hex, timestamp: Number(x.timestamp) }; blockCache.set(n, b); } return b; };
    const receipts = new Map<string, any>();
    for (const { l } of logs) if (!receipts.has(low(l.transactionHash))) receipts.set(low(l.transactionHash), await pub.getTransactionReceipt({ hash: l.transactionHash }));
    const grantTxs = new Set((rail.summary?.grant?.txs ?? []).map(low));
    const provisionJob = grantTxs.size ? (rail.store.jobs(200).find((r) => r.kind === "provision" && r.status === "done")?.id as string | undefined) ?? null : null;

    const out: MovementView[] = [];
    for (const { kind, l, viaDispute } of logs) {
      const tx = low(l.transactionHash);
      const r = receipts.get(tx);
      const b = await blockOf(l.blockNumber);
      const escrowLogs = parseEventLogs({ abi: rail.v.abi.ProofEscrowAbi, logs: r.logs.filter((x: any) => low(x.address) === low(escrow)) }) as any[];
      const jobId = (rail.store.receipt(l.transactionHash)?.job_id as string | undefined) ?? (grantTxs.has(tx) ? provisionJob : null);
      const base = { txHash: tx as Hex, logIndex: Number(l.logIndex), blockNumber: l.blockNumber.toString(), blockHash: low(l.blockHash) as Hex, blockTimestamp: b.timestamp, confirmations: Number(head.number - BigInt(l.blockNumber) + 1n), jobId };
      if (kind === "escrow-settled" && viaDispute && D) {
        const job = asClientD.get(l.args.id.toString());
        const t = tokens.find((x) => low(x.address) === low(job.token));
        out.push({ ...base, kind, token: getAddress(job.token), symbol: t?.symbol ?? "another token", decimals: t?.decimals ?? 0, amount: BigInt(l.args.toProvider).toString(), from: getAddress(D.address), to: getAddress(job.payee), fromRole: null, toRole: roleOf(job.payee), counterparty: counterpartyOf(getAddress(job.payee)), escrow: { jobId: job.escrowJobId.toString(), event: "settled", role: "client" }, conversion: null });
        continue;
      }
      if (kind === "escrow-settled") {
        const job = asClient.get(l.args.jobId.toString());
        const t = tokens.find((x) => low(x.address) === low(job.token));
        out.push({ ...base, kind, token: getAddress(job.token), symbol: t?.symbol ?? "another token", decimals: t?.decimals ?? 0, amount: l.args.price.toString(), from: escrow, to: getAddress(l.args.payee), fromRole: null, toRole: roleOf(l.args.payee), counterparty: counterpartyOf(getAddress(l.args.payee)), escrow: { jobId: l.args.jobId.toString(), event: "settled", role: "client" }, conversion: null });
        continue;
      }
      const t = tokenOf(l.address);
      const fromA = getAddress(l.args.from), toA = getAddress(l.args.to);
      const fromRole = roleOf(fromA), toRole = roleOf(toA);
      const cp = counterpartyOf(fromRole && toRole ? toA : fromRole ? toA : fromA);
      // the escrow job this transfer is part of, and this workspace's side of it
      let esc: MovementView["escrow"] = null;
      if (cp.kind === "escrow" && D && low(cp.address) === low(D.address)) {
        // through the dispute escrow: opened by this client; paid to this provider's vault; or paid back to this client
        const dl = parseEventLogs({ abi: D.abi as never, logs: r.logs.filter((x: any) => low(x.address) === low(D.address)) }) as any[];
        const opened = dl.find((e) => e.eventName === "JobOpened" && low(e.args.client) === low(owner));
        const closed = dl.find((e) => e.eventName === "Closed");
        if (fromRole && opened) esc = { jobId: opened.args.escrowJobId.toString(), event: "opened", role: "client" };
        else if (toRole && closed) {
          const dj = (await rail.read(D.address, D.abi, "getJob", [closed.args.id])) as { payee: Address; client: Address; escrowJobId: bigint };
          if (low(dj.payee) === low(toA)) esc = { jobId: dj.escrowJobId.toString(), event: "settled", role: "provider" };
          else if (low(dj.client) === low(toA)) esc = { jobId: dj.escrowJobId.toString(), event: "refunded", role: "client" };
        }
      } else if (cp.kind === "escrow") {
        const opened = escrowLogs.find((e) => e.eventName === "JobOpened" && low(e.args.client) === low(owner));
        const paid = escrowLogs.find((e) => e.eventName === "JobSettled" && low(e.args.payee) === low(toA));
        const refunded = escrowLogs.find((e) => e.eventName === "JobRefunded" && low(e.args.client) === low(toA));
        if (fromRole && opened) esc = { jobId: opened.args.jobId.toString(), event: "opened", role: "client" };
        else if (toRole && paid) esc = { jobId: paid.args.jobId.toString(), event: "settled", role: "provider" };
        else if (toRole && refunded) esc = { jobId: refunded.args.jobId.toString(), event: "refunded", role: "client" };
      }
      // a conversion: every pool hop of the transaction, with the pool's fee and its reserves before the swap
      let conv: MovementView["conversion"] = null;
      if (cp.kind === "conversion") {
        const hops: MovementHop[] = [];
        for (let i = 0; i < r.logs.length; i++) {
          const x = r.logs[i];
          if (!conversion.has(low(x.address))) continue;
          const [ev] = parseEventLogs({ abi: rail.v.abi.CPMMPoolAbi, logs: [x] }) as any[];
          if (ev?.eventName !== "Swap") continue;
          const [sync] = parseEventLogs({ abi: rail.v.abi.CPMMPoolAbi, logs: r.logs.slice(0, i).filter((y: any) => low(y.address) === low(x.address)).slice(-1) }) as any[];
          if (sync?.eventName !== "Sync") continue;
          const p = await pool(getAddress(x.address));
          const a = ev.args;
          const zeroForOne = a.amount0In > 0n;
          const [r0, r1] = [BigInt(sync.args.reserve0) - a.amount0In + a.amount0Out, BigInt(sync.args.reserve1) - a.amount1In + a.amount1Out];
          hops.push({ pool: getAddress(x.address), label: rail.venueLabel(getAddress(x.address)), feeBps: p.feeBps, tokenIn: zeroForOne ? p.token0 : p.token1, tokenOut: zeroForOne ? p.token1 : p.token0, amountIn: (zeroForOne ? a.amount0In : a.amount1In).toString(), amountOut: (zeroForOne ? a.amount1Out : a.amount0Out).toString(), reserveInBefore: (zeroForOne ? r0 : r1).toString(), reserveOutBefore: (zeroForOne ? r1 : r0).toString() });
        }
        const [best] = parseEventLogs({ abi: rail.v.abi.QEDExecutionAbi, logs: r.logs.filter((x: any) => low(x.address) === low(rail.a.exec)), eventName: "BestExecution" }) as any[];
        conv = { hops, amountIn: best ? best.args.amountIn.toString() : null, spent: best ? best.args.spent.toString() : null, amountOut: best ? best.args.amountOut.toString() : null, tokenOut: best ? getAddress(best.args.tokenOut) : null };
      }
      out.push({ ...base, kind, token: t.address, symbol: t.symbol, decimals: t.decimals, amount: l.args.value.toString(), from: fromA, to: toA, fromRole, toRole, counterparty: cp, escrow: esc, conversion: conv });
    }

    const canonical: Record<string, Hex | null> = {};
    for (const n of blocks) canonical[n.toString()] = n > head.number ? null : (await blockOf(n)).hash;
    return {
      network: `eip155:${CHAIN_ID}`, chainId: CHAIN_ID, genesisId: rail.genesisId,
      head: { number: head.number.toString(), hash: head.hash as Hex, timestamp: Number(head.timestamp) },
      range: { from: from.toString(), to: (from > to ? from - 1n : to).toString(), complete },
      finality: { kind: "confirmations", depth: 2, source: "R7 decision D6 (two confirmations by default); the authority budget counts a settlement after the same two (rail/host.ts)" },
      holders, tokens, movements: out, canonical,
    };
  }

  return { read, parseQuery };
}
