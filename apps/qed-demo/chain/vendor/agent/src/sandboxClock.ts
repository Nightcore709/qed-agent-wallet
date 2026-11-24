/**
 * Certificate issuance time. A long-idle auto-mining Anvil chain can leave its
 * last mined block hours behind real time, then stamp the next transaction with
 * wall-clock time. Issuing a four-hour certificate from the stale *last* block
 * would make a valid freshly approved operation fail before broadcast.
 *
 * Sandbox-only correction. On public chains, exclusively trust chain time.
 * The returned time never predates the observed block or server wall clock in
 * Anvil; the existing signed certificate validity window is unchanged.
 */
export function certificateNow(blockSeconds: number, chainId: number, wallSeconds: number = Math.floor(Date.now() / 1000)): number {
  if (!Number.isSafeInteger(blockSeconds) || !Number.isSafeInteger(wallSeconds) || blockSeconds < 0 || wallSeconds < 0) {
    throw new RangeError("Invalid certificate timestamp");
  }
  return chainId === 31337 ? Math.max(blockSeconds, wallSeconds) : blockSeconds;
}
