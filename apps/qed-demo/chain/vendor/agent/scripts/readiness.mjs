/**
 * Readiness for /api/health, which Railway uses as the deployment healthcheck: Railway switches traffic to a new
 * deployment only after it answers 200. In public mode we answer 503 until the service can genuinely serve —
 * sandbox initialised, Anvil answering, contracts deployed, release manifest verified — so a broken image is never
 * activated and the previous deployment keeps serving. Locally the status stays 200 (development and tests) with the
 * same fields. Anthropic availability is reported elsewhere in the response and never gates readiness.
 */
export function readinessReport({ publicMode, sandboxStatus, probe, identity, now = Date.now() }) {
  const manifestVerified = identity?.sourceVerified === true;
  const readiness = {
    sandbox: sandboxStatus,
    anvil: probe?.anvil === true,
    contracts: probe?.contracts === true,
    // Locally a manifest exists only in a staged release; null means "not required here".
    manifest: publicMode || identity?.sourceDigest ? manifestVerified : null,
    checkedAt: new Date(now).toISOString(),
  };
  const ready = sandboxStatus === "ready" && readiness.anvil && readiness.contracts && (!publicMode || manifestVerified);
  const status = !publicMode || ready ? "ok" : sandboxStatus === "starting" ? "starting" : "unavailable";
  return { ready, status, httpStatus: publicMode && !ready ? 503 : 200, readiness };
}

/** Reuses one probe for `ttlMs` and never runs two at once: health checks stay cheap on the public endpoint, and a
 *  failed probe is retried on the next request after the TTL, so a transient stall or a reset recovers by itself. */
export function cachedProbe(probe, ttlMs = 2_000, clock = () => Date.now()) {
  let value = null, at = 0, pending = null;
  return () => {
    if (value && clock() - at < ttlMs) return Promise.resolve(value);
    pending ??= Promise.resolve()
      .then(probe)
      .catch(() => ({ anvil: false, contracts: false }))
      .then((v) => { value = v; at = clock(); pending = null; return v; });
    return pending;
  };
}
