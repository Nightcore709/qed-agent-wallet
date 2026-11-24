/**
 * One authoritative clock for the rail: the chain's block time, kept on the wall clock by the rail itself.
 *
 * Rule (baseline W-24, F-084):
 *   - at start, after every detected gap and before every transaction the rail aligns the chain to the wall clock;
 *   - both times are stored with each decision;
 *   - when the chain is AHEAD of the wall clock by more than the limit, the rail refuses with both times shown
 *     (a chain cannot be moved backwards, so alignment cannot repair that case).
 *
 * Findings on Anvil 1.7.1 that this file relies on (probed 2026-11-19/20, recorded in README.md):
 *   - evm_setNextBlockTimestamp accepts a value equal to the latest block's, and rejects a lower one;
 *   - a burst of auto-mined transactions shares one timestamp, so plain sending never makes the chain run ahead;
 *   - the release's replica idiom max(wall, latest + 1) before every transaction DOES make it run ahead
 *     (11 s after 12 transactions), so the rail aligns with max(wall, latest) and never enables that mode;
 *   - eth_call at "latest" sees the latest block's time (stale when idle); at "pending" it sees the wall clock.
 *
 * A machine that sleeps suspends this process and Anvil without restarting either. GapDetector notices the silence
 * between two of the rail's own heartbeats, so the chain is realigned and the gap recorded even though nothing
 * restarted.
 */
import type { ClockReading } from "../types.ts";

export type RpcCall = (method: string, params?: unknown[]) => Promise<unknown>;

export class ClockSkewError extends Error {
  code = "clock_skew";
  details: Record<string, unknown>;
  constructor(reading: ClockReading) {
    super(
      `The chain clock is ahead of the wall clock by ${-reading.skewSeconds} s (limit ${reading.limitSeconds} s): chain time ${new Date(reading.chainSeconds * 1000).toISOString()}, wall time ${reading.wallTime}. No transaction was sent.`,
    );
    this.name = "ClockSkewError";
    this.details = { ...reading };
  }
}

const hex = (n: number) => `0x${n.toString(16)}`;

export function reading(chainSeconds: number, wallMs: number, limitSeconds: number): ClockReading {
  const wallSeconds = Math.floor(wallMs / 1000);
  const skewSeconds = wallSeconds - chainSeconds;
  return { wallTime: new Date(wallMs).toISOString(), wallSeconds, chainSeconds, skewSeconds, limitSeconds, withinLimit: -skewSeconds <= limitSeconds };
}

/**
 * Aligns the NEXT block to the wall clock and returns the reading taken before alignment.
 * Throws ClockSkewError when the chain leads by more than the limit. Mines nothing.
 */
export async function alignNextBlock(rpc: RpcCall, latestTimestamp: () => Promise<number>, wallMs: number, limitSeconds: number): Promise<ClockReading> {
  const r = reading(await latestTimestamp(), wallMs, limitSeconds);
  if (!r.withinLimit) throw new ClockSkewError(r);
  if (r.wallSeconds > r.chainSeconds) await rpc("evm_setNextBlockTimestamp", [hex(r.wallSeconds)]);
  return r;
}

/**
 * Mines one empty block at wall time, so the latest block itself carries the wall clock (used at start, after a
 * restore and after a gap). Returns the reading before and the chain time after. Throws ClockSkewError when ahead.
 */
export async function anchor(rpc: RpcCall, latestTimestamp: () => Promise<number>, wallMs: number, limitSeconds: number): Promise<{ before: ClockReading; chainAfter: number; mined: boolean }> {
  const before = reading(await latestTimestamp(), wallMs, limitSeconds);
  if (!before.withinLimit) throw new ClockSkewError(before);
  if (before.wallSeconds <= before.chainSeconds) return { before, chainAfter: before.chainSeconds, mined: false };
  await rpc("evm_setNextBlockTimestamp", [hex(before.wallSeconds)]);
  await rpc("evm_mine", []);
  return { before, chainAfter: await latestTimestamp(), mined: true };
}

export type GapKind =
  | "suspend" //         the wall clock advanced while this process's monotonic clock did not: the machine slept
  //                     (a wall clock set forward looks the same and is treated the same)
  | "stall" //           both clocks advanced: the process was running but not scheduled, or its event loop was blocked
  | "clock-set-back"; // the wall clock moved backwards relative to the monotonic clock

export interface Gap {
  kind: GapKind;
  wallBefore: string;
  wallAfter: string;
  /** Wall-clock seconds between the two observations. */
  wallSeconds: number;
  /** Monotonic seconds between the two observations (excludes machine sleep on macOS and Linux). */
  monotonicSeconds: number;
  thresholdSeconds: number;
}

/**
 * Call observe() on every heartbeat and before every operation. It returns a Gap when more wall time passed since
 * the previous observation than the threshold, or when the wall clock went backwards by more than it.
 */
export class GapDetector {
  private lastWall: number;
  private lastMono: number;
  private readonly wall: () => number;
  private readonly mono: () => number;
  private readonly thresholdMs: number;
  constructor(wall: () => number, mono: () => number, thresholdMs: number) {
    this.wall = wall;
    this.mono = mono;
    this.thresholdMs = thresholdMs;
    this.lastWall = wall();
    this.lastMono = mono();
  }
  observe(): Gap | null {
    const wallNow = this.wall(), monoNow = this.mono();
    const wallDelta = wallNow - this.lastWall, monoDelta = monoNow - this.lastMono;
    const before = this.lastWall;
    this.lastWall = wallNow;
    this.lastMono = monoNow;
    let kind: GapKind | null = null;
    if (wallDelta - monoDelta > this.thresholdMs) kind = "suspend";
    else if (monoDelta - wallDelta > this.thresholdMs) kind = "clock-set-back";
    else if (wallDelta > this.thresholdMs) kind = "stall";
    if (!kind) return null;
    return { kind, wallBefore: new Date(before).toISOString(), wallAfter: new Date(wallNow).toISOString(), wallSeconds: Math.round(wallDelta / 1000), monotonicSeconds: Math.round(monoDelta / 1000), thresholdSeconds: Math.round(this.thresholdMs / 1000) };
  }
}
