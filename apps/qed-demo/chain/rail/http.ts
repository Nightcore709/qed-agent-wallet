/**
 * The rail as JSON over HTTP, for one client: the wallet's backend on the same machine.
 *
 * Host routes: GET /health (no token), POST /workspaces, GET /quota (the host's budget over all workspaces). Every
 * other route is a WORKSPACE route under /workspaces/:workspaceId/…; an unknown workspace is 404 unknown_workspace
 * (answered only after the token was checked), and every proposal, job, receipt, decision record and submission key
 * is looked up in that workspace only.
 *
 *   - listens on 127.0.0.1 only (the caller binds it; see main.ts);
 *   - every route except GET /health needs `Authorization: Bearer <token>` (constant-time comparison);
 *   - no CORS: no Access-Control header is ever sent, and any request carrying an Origin header is refused, so a
 *     browser page cannot use it; the Host header must be a loopback name (defence against DNS rebinding);
 *   - request bodies are JSON, at most MAX_BODY bytes;
 *   - errors are { error: { code, message, details? } } with no stack, no file path and no RPC address;
 *   - state-changing routes need an Idempotency-Key header and answer 202 with the job to follow;
 *   - a spent budget answers 429 with a Retry-After header (the rail's own quota, rail/service.ts → requireBudget).
 *
 * Every route in the table below must be documented in README.md with an example (test/contract.test.ts checks it).
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { timingSafeEqual } from "node:crypto";
import { RailError, publicError } from "./service.ts";
import type { Rail, RailHost } from "./host.ts";
import * as L from "../language/index.ts";
import { ApprovalError } from "../terms.ts";

export const MAX_BODY = 16_384;
/** A refutation may be large: MaximalityBounty accepts 128 debts, about 33 KB of calldata (rail/bounties.ts). */
export const MAX_CLAIM_BODY = 131_072;

export interface RouteContext {
  /** The workspace of a workspace route (undefined on a host route). */
  rail: Rail;
  host: RailHost;
  params: Record<string, string>;
  query: URLSearchParams;
  body: any;
  idempotencyKey: string | undefined;
  req: IncomingMessage;
  res: ServerResponse;
}
export interface Route {
  method: "GET" | "POST";
  path: string; //        "/jobs/:id/events"
  auth: boolean;
  summary: string;
  /** A larger request body than MAX_BODY, for the routes that carry a bounty claim (at most MAX_CLAIM_BODY). */
  maxBody?: number;
  /** Returns the JSON body, or [status, body], or undefined when the handler wrote the response itself. */
  handle: (c: RouteContext) => unknown | Promise<unknown>;
}

const int = (q: URLSearchParams, name: string, fallback: number) => {
  const v = q.get(name);
  if (v === null) return fallback;
  if (!/^\d{1,4}$/.test(v)) throw new RailError("invalid_query", `${name} must be a whole number.`, 422);
  return Number(v);
};
const accepted = (c: RouteContext, a: { jobId: string }) => {
  c.res.setHeader("Location", `/workspaces/${c.rail.id}/jobs/${a.jobId}`);
  return [202, a];
};

const text = (body: any, field: string, max = 2000): string => {
  const v = body?.[field];
  if (typeof v !== "string" || v.trim().length < 2 || v.length > max) throw new RailError("invalid_request", `${field} must be a string of 2 to ${max} characters.`, 422);
  return v.trim();
};

/** Routes of the host itself. */
export const HOST_ROUTES: Route[] = [
  { method: "GET", path: "/health", auth: false, summary: "Readiness: 200 only when Anvil, the contracts, the store and the co-signer answer; 503 otherwise", handle: async (c) => { const h = await c.host.health(); return [h.ready ? 200 : 503, h]; } },
  { method: "POST", path: "/workspaces", auth: true, summary: "Create a workspace for a passkey owner: owner account, vault set owned by it from the first block, keys, store, opening test grant. Idempotent by workspaceId", handle: async (c) => { const v = await c.host.createWorkspace(c.body); return [v.duplicate ? 200 : 201, v]; } },
  { method: "GET", path: "/cosigner/self-test", auth: true, summary: "R13 review fix F3: the co-signer signs one fixed text (EIP-191, never a certificate) with the baseline scope's key, so that the deployed image's isolation check can see that it still signs", handle: (c) => c.host.cosignerSelfTest() },
  { method: "GET", path: "/quota", auth: true, summary: "The host's budget over all workspaces together: per class the limit, what is used in the rolling window and when one more is allowed", handle: (c) => { c.host.requireReady(); return c.host.globalQuota(); } },
];

/** Routes of one workspace, relative to /workspaces/:workspaceId. */
export const WORKSPACE_ROUTES: Route[] = [
  { method: "GET", path: "", auth: true, summary: "The workspace: owner account and how its authority is held, signers (as the chain holds them now), contracts, keys, assets, opening grant", handle: async (c) => { await c.rail.signers.refresh(); return c.rail.view(); } },
  { method: "GET", path: "/state", auth: true, summary: "Treasury state: accounts, balances, venues with reserves, mandate with usage per limit, worst-case loss, clock, roles, contracts, last trade", handle: (c) => c.rail.state() },
  { method: "GET", path: "/limits", auth: true, summary: "Limit check for ?amount= (nothing is sent): every rule with usage and what remains, and the maximum", handle: (c) => c.rail.limits(c.query.get("amount")) },
  { method: "GET", path: "/maximum", auth: true, summary: "The largest amount every limit allows right now", handle: (c) => c.rail.maximum() },
  { method: "GET", path: "/quote", auth: true, summary: "Read-only quote for ?amount=: expected output, on-chain bound, gap, route, alternatives, source and freshness", handle: (c) => c.rail.quote(c.query.get("amount")) },
  { method: "GET", path: "/mandates", auth: true, summary: "Every mandate ever signed, newest first, with status and usage", handle: async (c) => ({ mandates: await c.rail.mandates() }) },
  { method: "GET", path: "/attacks", auth: true, summary: "The six Security Lab attacks with the expected error and the defending layer", handle: (c) => ({ attacks: c.rail.attacks() }) },
  { method: "GET", path: "/history", auth: true, summary: "Activity, newest first (?limit=, default 40)", handle: (c) => ({ history: c.rail.history(int(c.query, "limit", 40)) }) },
  { method: "GET", path: "/decisions", auth: true, summary: "Hash-chained decision records, newest first (?limit=), or all of one job (?jobId=)", handle: (c) => ({ decisions: c.rail.decisions(int(c.query, "limit", 50), c.query.get("jobId") ?? undefined) }) },
  { method: "GET", path: "/decisions/verify", auth: true, summary: "Recomputes the decision-record hash chain", handle: (c) => c.rail.verifyDecisions() },
  { method: "GET", path: "/clock", auth: true, summary: "Chain time against wall time, and recorded clock events (restarts, sleep gaps, refusals)", handle: async (c) => ({ clock: await c.rail.clock(), events: c.rail.clockEvents(int(c.query, "limit", 50)) }) },
  { method: "GET", path: "/movements", auth: true, summary: "What moved in and out of the wallet, read from the chain's logs (?fromBlock=, ?toBlock=): each Transfer of its two tokens into or out of its vaults and owner account, and the escrow's settlement of work it commissioned, by transaction hash and log index, with block, time, confirmations, counterparty, the job that sent it and a conversion's pool hops; ?blocks= gives the hash the chain now holds at those heights", handle: (c) => c.rail.movements.read(c.query) },
  { method: "GET", path: "/receipts/:hash", auth: true, summary: "The stored receipt of a transaction and what the chain says now", handle: (c) => c.rail.receipt(c.params.hash) },
  { method: "POST", path: "/proposals", auth: true, summary: "Prepare an owner- or guardian-authorised action: returns the exact terms and their hash. Signs nothing", handle: async (c) => [201, await c.rail.propose(c.body)] },
  { method: "GET", path: "/proposals/:id", auth: true, summary: "One proposal with its terms, hash, checks and status", handle: (c) => c.rail.proposal(c.params.id) },
  { method: "POST", path: "/proposals/:id/cancel", auth: true, summary: "Cancel an open proposal", handle: (c) => c.rail.cancelProposal(c.params.id) },
  { method: "POST", path: "/proposals/:id/execute", auth: true, summary: "Execute a proposal with the owner's approval of its exact terms (and, in a passkey workspace, the passkey's signatures, checked on chain first). Needs Idempotency-Key", handle: async (c) => accepted(c, await c.rail.executeChecked(c.params.id, c.body?.approval, c.idempotencyKey)) },
  { method: "GET", path: "/policy", auth: true, summary: "The standing policy (target, tranche bounds, enforcement, shortfall) and its ticks with the five candidates each", handle: async (c) => ({ policy: await c.rail.policyView(), ticks: c.rail.policy.ticks(int(c.query, "limit", 30)) }) },
  { method: "POST", path: "/policy/tick", auth: true, summary: "One tick of the signed policy: observe, decide, co-sign, trade or stop. For the backend's scheduler. Needs Idempotency-Key", handle: (c) => accepted(c, c.rail.submit("policy-tick", {}, c.idempotencyKey)) },
  { method: "POST", path: "/policy/run", auth: true, summary: "Run ticks on the server until the target is met or a stop condition holds. Needs Idempotency-Key", handle: (c) => accepted(c, c.rail.submit("policy-run", c.rail.policy.runParams(c.body), c.idempotencyKey)) },
  { method: "GET", path: "/scenarios", auth: true, summary: "The six configurable scenarios with their input bounds, schema and availability", handle: (c) => ({ scenarios: c.rail.scenarios.list() }) },
  { method: "GET", path: "/economies", auth: true, summary: "The four scripted economies and whether one is running", handle: (c) => ({ economies: c.rail.economies.list(), running: c.rail.economies.active() }) },
  { method: "POST", path: "/economies/run", auth: true, summary: "Start one scripted economy on its own chain (one at a time). Needs Idempotency-Key", handle: (c) => accepted(c, c.rail.economies.start(c.body, c.idempotencyKey)) },
  { method: "GET", path: "/evidence", auth: true, summary: "Historical Sepolia evidence index, read-only; every row is labelled HISTORICAL", handle: (c) => c.rail.scenarios.evidence() },
  { method: "GET", path: "/liabilities", auth: true, summary: "The treasury vault's ring-fenced liabilities (owner ring-fences and forward payments) with creditor, amount, due time and status", handle: async (c) => ({ liabilities: await c.rail.treasury.liabilities() }) },
  { method: "POST", path: "/liabilities/:id/settle", auth: true, summary: "Pay a due liability to its creditor. No approval: the contract lets anyone do it, also while paused. Needs Idempotency-Key", handle: async (c) => { await c.rail.treasury.liability(c.params.id); return accepted(c, c.rail.submit("settle", c.rail.treasury.settleParams(c.params.id), c.idempotencyKey)); } },
  { method: "GET", path: "/payments/limits", auth: true, summary: "Limit check for a payment of ?amount= (nothing is sent, no proposal is made): every rule with usage and what remains, and what is left of the co-signer's earned allowance", handle: (c) => c.rail.treasury.paymentLimits(c.query.get("amount")) },
  { method: "GET", path: "/quota", auth: true, summary: "The rail's own budget: per class the limit, what is used in the rolling window and when one more is allowed", handle: (c) => c.rail.quota() },
  { method: "GET", path: "/language/capabilities", auth: true, summary: "The nine-tool registry with exact schemas, the model tool list and the knowledge topics", handle: () => ({ capabilities: L.CAPABILITIES, modelTools: L.MODEL_TOOLS, knowledge: L.KNOWLEDGE }) },
  { method: "POST", path: "/language/screen", auth: true, summary: "Run the deterministic guard on a raw message, before any model call", handle: (c) => L.screenMessage(text(c.body, "message")) },
  { method: "POST", path: "/language/validate", auth: true, summary: "Validate a model-proposed tool call against the registry; optionally against the owner's own number", handle: (c) => {
    if (typeof c.body?.tool !== "string") throw new RailError("invalid_request", "Supply { tool, input, message? }.", 422);
    const v = L.validateToolCall(c.body.tool, c.body.input);
    if (v.ok && c.body.message !== undefined) { const a = L.checkExplicitAmount(text(c.body, "message"), [{ name: c.body.tool, input: c.body.input }]); if (!a.ok) return a; }
    return v;
  } },
  { method: "POST", path: "/language/parse", auth: true, summary: "The labelled offline parser plus guard on a message, against the treasury's current state. Proposes only", handle: async (c) => {
    const am = c.rail.activeMandate();
    return L.parseOffline(text(c.body, "message"), (await c.rail.chatContext()) as never, am ? am.mandate.maxPerPayment : 0n);
  } },
  { method: "POST", path: "/language/amount", auth: true, summary: "The exact amount lexer on a text", handle: (c) => L.scanAmount(text(c.body, "text", 2000)) },
  { method: "POST", path: "/language/topic", auth: true, summary: "Which fixed knowledge topic a question is about, with its answer", handle: (c) => { const topic = L.identifyKnowledgeTopic(text(c.body, "message")); return { topic, knowledge: topic ? L.KNOWLEDGE[topic] : null }; } },
  { method: "GET", path: "/jobs", auth: true, summary: "Recent jobs, newest first (?limit=, default 30)", handle: (c) => ({ jobs: c.rail.jobs(int(c.query, "limit", 30)) }) },
  { method: "GET", path: "/jobs/:id", auth: true, summary: "One job: status, steps, result, error and guidance", handle: (c) => c.rail.job(c.params.id) },
  { method: "GET", path: "/jobs/:id/events", auth: true, summary: "Server-sent step stream of one job: past steps, then live ones, then `done`", handle: (c) => sse(c) },
  { method: "GET", path: "/submissions/:key", auth: true, summary: "Recovery by lookup: the job an Idempotency-Key started, if any", handle: (c) => c.rail.submission(c.params.key) },
  { method: "GET", path: "/scheduled", auth: true, summary: "Owner changes scheduled behind the owner account's delay: what each does, from when it may be applied, and whether it is pending, applied or cancelled", handle: async (c) => ({ scheduled: await c.rail.scheduled() }) },
  { method: "POST", path: "/scheduled/:changeId/apply", auth: true, summary: "Apply a scheduled change once its delay has passed. No approval: the owner account lets anyone do it. Needs Idempotency-Key", handle: (c) => accepted(c, c.rail.submit("apply-change", c.rail.applyParams(c.params.changeId), c.idempotencyKey)) },
  // ───────────── signers and recovery (RISK-053) ─────────────
  { method: "GET", path: "/signers", auth: true, summary: "The owner account's signers (members and recovery keys), thresholds, delays and pending signer changes, as the chain holds them now", handle: (c) => c.rail.signers.view() },
  { method: "GET", path: "/recovery/digest", auth: true, summary: "The digest a recovery key signs to add ?x=&y= as a member (?recoverySignerId=, ?deadline=). Nothing is prepared or sent", handle: (c) => c.rail.signers.digest(c.query) },
  { method: "POST", path: "/signers/freeze", auth: true, summary: "R13: freeze one member of the owner account at once with this workspace's sentinel key ({ signerId }): its approval stops counting for execute and ERC-1271; it keeps its veto and may still protect. Refused (409 no_sentinel) for an account built before R13. Needs Idempotency-Key", handle: (c) => accepted(c, c.rail.submit("freeze-signer", c.rail.signers.freezeParams(c.body), c.idempotencyKey)) },
  { method: "GET", path: "/recoveries/:recoveryId/withdraw-digest", auth: true, summary: "R13 review fix F1: what the guardian's passkey signs to withdraw its co-signature of a pending recovery (the account's cancel digest for it); refused unless the guardian co-signed it", handle: (c) => c.rail.signers.withdrawDigest(c.params.recoveryId) },
  { method: "POST", path: "/recoveries/:recoveryId/withdraw", auth: true, summary: "R13 review fix F1: the guardian withdraws its co-signature ({ assertion } over the withdraw digest): the account cancels the recovery and spends its recovery key. Needs Idempotency-Key", handle: (c) => accepted(c, c.rail.submit("guardian-withdraw", c.rail.signers.withdrawParams(c.params.recoveryId, c.body), c.idempotencyKey)) },
  { method: "POST", path: "/recoveries/:recoveryId/stop", auth: true, summary: "R13 H1: stop a pending recovery the guardian co-signed with this workspace's sentinel key ({}): the owner's way to challenge it through QED, even with every passkey frozen. Protective only: it cancels that recovery and spends its key, nothing else. Needs Idempotency-Key", handle: (c) => accepted(c, c.rail.submit("sentinel-stop", c.rail.signers.stopParams(c.params.recoveryId, c.body), c.idempotencyKey)) },
  { method: "POST", path: "/recoveries", auth: true, summary: "Start a recovery with a recovery key's raw P-256 signature over its digest: the new passkey becomes a member after the recovery delay unless a member cancels. No member signs. Needs Idempotency-Key", handle: (c) => accepted(c, c.rail.submit("start-recovery", c.rail.signers.recoveryParams(c.body), c.idempotencyKey)) },
  { method: "POST", path: "/links", auth: true, summary: "Declare workspaces that have a member in common with this one (R7 D1): none of them counts as an outside client of another (D7). Links are only ever added", handle: (c) => c.host.addLinks(c.rail.id, c.body?.workspaces) },
  // ───────────── earning through the proof escrow (R7-054) ─────────────
  { method: "GET", path: "/escrow/jobs", auth: true, summary: "Proof-escrow jobs this workspace is a party to (client, provider or payee), newest first (?quoteHash= for one quote's), with what each settlement does to the authority budget", handle: async (c) => ({ jobs: await c.rail.escrow.jobs(c.query.get("quoteHash")) }) },
  { method: "GET", path: "/escrow/jobs/:jobId", auth: true, summary: "One proof-escrow job this workspace is a party to: status, parties, terms, transactions, and for the payee its effect on the authority budget", handle: (c) => c.rail.escrow.job(c.params.jobId) },
  { method: "POST", path: "/escrow/jobs/:jobId/refund", auth: true, summary: "Refund an open job to its client after its deadline. No approval: the escrow lets anyone do it then. Needs Idempotency-Key", handle: async (c) => accepted(c, c.rail.submit("escrow-refund", await c.rail.escrow.refundParams(c.params.jobId), c.idempotencyKey)) },
  // ───────────── ownership and creditor operations (R13 S5) ─────────────
  { method: "GET", path: "/ownership", auth: true, summary: "Who owns this workspace's two vaults and any offer of them pending, the owner account's delay, and vaults of this installation offered to or owned by this owner account", handle: (c) => c.rail.ownership.state() },
  { method: "GET", path: "/claims", auth: true, summary: "Liabilities of any vault of this installation that name, or named, this owner account as creditor: the claims it can release or assign", handle: async (c) => ({ claims: await c.rail.ownership.claims() }) },
  { method: "POST", path: "/disputes/:disputeId/finish", auth: true, summary: "Apply the timeout outcome of a job of the dispute escrow once its review or its decision period has run out (R13 E3). No approval: the dispute escrow lets anyone do it then. This workspace must be a party or the named decider. Needs Idempotency-Key", handle: async (c) => accepted(c, c.rail.submit("escrow-finish", await c.rail.escrow.finishParams(c.params.disputeId), c.idempotencyKey)) },
  { method: "POST", path: "/escrow/problems/preview", auth: true, summary: "The certified answer to a problem a quote may name ({ kind: \"helix\" } or { kind: \"custom\", assets }), computed by the release's solver. Nothing is prepared or sent", handle: (c) => c.rail.escrow.preview(c.body?.problem) },
  // ───────────── refutation bounties: the claim path that pays the committed finder (R11 §9) ─────────────
  { method: "GET", path: "/bounties", auth: true, summary: "The local bounty board (shared by every workspace): each bounty's judge, pool, phase, winner and periods, the EIP-712 domain of commitments; and this workspace's claimant and claims, each with its state read from the chain", handle: async (c) => ({ ...(await c.rail.bounties.board()), ...(c.host.bountyBoard ? await c.rail.bounties.claims() : { claimant: null, claims: [] }) }) },
  { method: "POST", path: "/bounties/:bountyId/check", auth: true, maxBody: MAX_CLAIM_BODY, summary: "Is { claim } a refutation? The bounty's judge answers through eth_call, with its own error for a rejected claim. Nothing is recorded or sent", handle: (c) => c.rail.bounties.check(c.params.bountyId, c.body) },
  { method: "POST", path: "/bounties/:bountyId/claims", auth: true, maxBody: MAX_CLAIM_BODY, summary: "Commit a claim ({ claim, payTo? }): refused with the judge's error unless it refutes the theorem; otherwise this workspace's claimant records an EIP-712 commitment (the claim stays private). Needs Idempotency-Key", handle: async (c) => accepted(c, c.rail.submit("bounty-commit", await c.rail.bounties.commitParams(c.params.bountyId, c.body), c.idempotencyKey)) },
  { method: "POST", path: "/bounties/claims/:claimId/reveal", auth: true, summary: "Reveal a committed claim of this workspace once it may be revealed and before it expires; simulated first, refused with the board's reason and nothing sent if the board would refuse it. Needs Idempotency-Key", handle: (c) => accepted(c, c.rail.submit("bounty-reveal", c.rail.bounties.revealParams(c.params.claimId), c.idempotencyKey)) },
  { method: "POST", path: "/bounties/:bountyId/settle", auth: true, summary: "Settle a bounty whose contest has closed: the board pays the winner's recipient. Anyone may; no approval. Needs Idempotency-Key", handle: (c) => accepted(c, c.rail.submit("bounty-settle", c.rail.bounties.settleParams(c.params.bountyId), c.idempotencyKey)) },
];

export const WORKSPACE_PREFIX = "/workspaces/:workspaceId";
/** Every route with its full path, as served. */
export const ROUTES: Route[] = [...HOST_ROUTES, ...WORKSPACE_ROUTES.map((r) => ({ ...r, path: `${WORKSPACE_PREFIX}${r.path}`, workspace: true }) as Route & { workspace: true })];

function sse(c: RouteContext): undefined {
  c.rail.job(c.params.id); // 404 before any header is written
  c.res.writeHead(200, { "Content-Type": "text/event-stream; charset=utf-8", "Cache-Control": "no-cache, no-transform", Connection: "keep-alive", "X-Accel-Buffering": "no" });
  c.res.write(": connected\n\n");
  const off = c.rail.subscribe(c.params.id, (s) => {
    if ("done" in s) {
      c.res.write(`event: done\ndata: ${JSON.stringify(c.rail.job(c.params.id))}\n\n`);
      c.res.end();
    } else c.res.write(`event: step\ndata: ${JSON.stringify(s)}\n\n`);
  });
  c.req.on("close", off);
  return undefined;
}

function match(path: string, pattern: string): Record<string, string> | null {
  const a = path.split("/"), b = pattern.split("/");
  if (a.length !== b.length) return null;
  const params: Record<string, string> = {};
  for (let i = 0; i < a.length; i++) {
    if (b[i].startsWith(":")) {
      if (!/^[A-Za-z0-9._:-]{1,140}$/.test(a[i])) return null;
      params[b[i].slice(1)] = a[i];
    } else if (a[i] !== b[i]) return null;
  }
  return params;
}

function send(res: ServerResponse, status: number, body: unknown) {
  if (res.headersSent) return;
  const text = JSON.stringify(body, (_, v) => (typeof v === "bigint" ? v.toString() : v));
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Content-Length": Buffer.byteLength(text) });
  res.end(text);
}
const fail = (res: ServerResponse, status: number, code: string, message: string, details?: Record<string, unknown>) => send(res, status, { error: { code, message, ...(details && Object.keys(details).length ? { details } : {}) } });

async function readBody(req: IncomingMessage, limit = MAX_BODY): Promise<unknown> {
  const declared = Number(req.headers["content-length"] ?? 0);
  if (declared > limit) throw new RailError("body_too_large", `Request body exceeds ${limit} bytes.`, 413);
  const parts: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > limit) throw new RailError("body_too_large", `Request body exceeds ${limit} bytes.`, 413);
    parts.push(chunk as Buffer);
  }
  if (!size) return {};
  if (!/^application\/json\b/i.test(String(req.headers["content-type"] ?? ""))) throw new RailError("unsupported_media_type", "Send JSON with Content-Type: application/json.", 415);
  try { return JSON.parse(Buffer.concat(parts).toString("utf8")); } catch { throw new RailError("invalid_json", "The request body is not valid JSON.", 400); }
}

export function createRailServer(host: RailHost, opts: { token: string; port: number; routes?: Route[] }): Server {
  const routes = opts.routes ?? ROUTES;
  const expected = Buffer.from(opts.token);
  const authorised = (req: IncomingMessage) => {
    const h = req.headers.authorization;
    if (typeof h !== "string" || !h.startsWith("Bearer ")) return false;
    const got = Buffer.from(h.slice(7));
    return got.length === expected.length && timingSafeEqual(got, expected);
  };
  const hosts = new Set([`127.0.0.1:${opts.port}`, `localhost:${opts.port}`, `[::1]:${opts.port}`]);
  const server = createServer(async (req, res) => {
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("X-Frame-Options", "DENY");
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("Content-Security-Policy", "default-src 'none'; frame-ancestors 'none'");
    res.setHeader("Referrer-Policy", "no-referrer");
    try {
      if (!hosts.has(String(req.headers.host ?? ""))) return fail(res, 421, "wrong_host", "This service answers on the loopback address only.");
      if (req.headers.origin !== undefined) return fail(res, 403, "cross_origin_refused", "Browser and cross-origin requests are not permitted. This service has one client: the wallet backend.");
      const method = req.method ?? "GET";
      const url = new URL(req.url ?? "/", "http://127.0.0.1");
      const candidates = routes.map((r) => ({ r, params: match(url.pathname, r.path) })).filter((x) => x.params);
      if (!candidates.length) return fail(res, 404, "not_found", "Not found.");
      const hit = candidates.find((x) => x.r.method === method);
      if (!hit) { res.setHeader("Allow", [...new Set(candidates.map((x) => x.r.method))].join(", ")); return fail(res, 405, "method_not_allowed", "Method not allowed."); }
      if (hit.r.auth && !authorised(req)) { res.setHeader("WWW-Authenticate", "Bearer"); return fail(res, 401, "unauthorised", "A valid bearer token is required."); }
      const body = method === "POST" ? await readBody(req, Math.min(hit.r.maxBody ?? MAX_BODY, MAX_CLAIM_BODY)) : undefined;
      if (method === "POST" && (body === null || typeof body !== "object" || Array.isArray(body))) return fail(res, 422, "invalid_request", "The request body must be a JSON object.");
      const key = req.headers["idempotency-key"];
      let rail = undefined as unknown as Rail;
      if ((hit.r as { workspace?: boolean }).workspace) {
        // the workspace is found only after the token was checked; an unknown one answers the same 404 for everyone
        host.requireReady();
        const ws = host.workspace(hit.params!.workspaceId);
        if (!ws) return fail(res, 404, "unknown_workspace", "Unknown workspace.");
        rail = ws;
      }
      const out = await hit.r.handle({ rail, host, params: hit.params!, query: url.searchParams, body, idempotencyKey: typeof key === "string" ? key : undefined, req, res });
      if (out === undefined) return;
      if (Array.isArray(out) && out.length === 2 && typeof out[0] === "number") return send(res, out[0], out[1]);
      return send(res, 200, out);
    } catch (e) {
      if (e instanceof RailError && e.http === 429 && typeof e.details.retryAfterSeconds === "number") res.setHeader("Retry-After", String(e.details.retryAfterSeconds));
      if (e instanceof RailError) return fail(res, e.http, e.code, e.message, e.details);
      if (e instanceof ApprovalError) return fail(res, 409, e.code, e.message, e.details);
      return fail(res, 500, "internal_error", publicError(e));
    }
  });
  server.requestTimeout = 30_000;
  server.headersTimeout = 10_000;
  server.maxHeadersCount = 40;
  server.on("clientError", (_e, socket) => { if (socket.writable) socket.end("HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n"); });
  return server;
}
