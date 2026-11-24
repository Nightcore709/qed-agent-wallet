/**
 * Types of the chain rail's JSON API. Erasable TypeScript only, no runtime imports: `import type { ... } from
 * "../chain/types.ts"` works on Node 26 without a loader or a build step.
 *
 * Conventions
 *   Money     decimal strings of RAW token units (tUSD and tEUR have 6 decimals, tETH 18). Never a float.
 *   Inputs    human decimal strings with at most six decimals ("22.5"), validated by the release's own parser.
 *   Times     ISO-8601 strings for wall time; unix seconds (numbers) for chain time.
 *   Ratios    gapPpm, shortfallBps and impactBps are numbers computed by the release's engines (not money).
 *   Labels    every object that could be mistaken for live or public-chain data carries `network` or `label`.
 */

export type Hex = `0x${string}`;
export type Address = `0x${string}`;
/** Decimal string of raw token units. */
export type Raw = string;

/** The baseline-parity host: the release's development keys, owner included (parity tests only). */
export const NETWORK_LABEL = "Local Anvil chain 31337 · valueless test tokens · development keys";
/** The multi-tenant host: keys derived from this installation's secret; every owner is a passkey account the service cannot satisfy. */
export const NETWORK_LABEL_MULTI = "Local Anvil chain 31337 · valueless test tokens · service keys derived from this installation's secret; owners are passkey accounts";

// ───────────────────────────── approvals and proposals ─────────────────────────────

/**
 * What the backend passes after the authenticated owner confirmed the exact terms.
 * The rail recomputes the hash of the terms it is about to sign and refuses unless it equals `termsHash`.
 */
export interface Approval {
  approvalId: string; //   unique per confirmation; a second use for other terms is refused
  docHash: string; //      hash of the document the owner was shown (opaque to the rail, stored with the decision)
  termsHash: string; //    "sha256:<hex>" of the canonical terms (see chain/terms.ts → hashTerms)
  confirmedAt: string; //  ISO time of the owner's confirmation
  method: string; //       how the owner confirmed, e.g. "passkey", "password+totp", "local-dev"
  /**
   * Passkey-owned workspaces only: one entry per item of `terms.toSign`, in order, each { assertions: PasskeyAssertion[] }
   * with at least the account's threshold of member assertions over that item's `digest`. Checked ON CHAIN by the rail.
   */
  signatures?: unknown[];
}

/** One member's WebAuthn assertion as the browser returns it, with the member's registered public key. */
export interface PasskeyAssertion {
  publicKey: { x: Hex; y: Hex };
  authenticatorData: Hex;
  /** The exact UTF-8 text the browser produced. */
  clientDataJSON: string;
  /** DER (as browsers return it) or 64-byte r||s. */
  signature: Hex;
}

/**
 * What the owner's passkey must sign for a proposal of a passkey-owned workspace (`terms.toSign`; covered by
 * `termsHash`). `digest` is the WebAuthn challenge: 32 bytes, base64url in clientDataJSON.
 */
export type ToSign =
  | {
      kind: "execute"; account: Address; chainId: number; nonce: string; deadline: string; calls: { target: Address; value: string; data: Hex; action: string }[]; digest: Hex; threshold: number; note: string;
      /** Present when some of the approved actions are guarded calls: they are not run now but scheduled behind the account's delay (QEDOwnerAccount.scheduleCalls). `actions` are their indexes in terms.actions. */
      schedule?: { calls: { target: Address; value: string; data: Hex; action: string }[]; actions: number[]; delaySeconds: string };
      /** R13: present (true) when the account's time-lock was on as these terms were prepared, so its lockable calls are in `schedule`. */
      timeLocked?: boolean;
    }
  /** `purpose` "quote": the hash is the proof escrow's EIP-712 digest of a work quote this workspace's owner account offers as provider (ProofEscrow.quoteDigest); the escrow checks it with ERC-1271. */
  | { kind: "erc1271"; account: Address; chainId: number; purpose: "mandate" | "message" | "quote"; hash: Hex; digest: Hex; threshold: number; note: string }
  /** One member's assertion cancels a scheduled change (QEDOwnerAccount.cancel): `signatures` carries exactly one assertion. */
  | { kind: "cancel"; account: Address; chainId: number; changeId: Hex; digest: Hex; threshold: 1; note: string };

/** A change scheduled behind the owner account's delay (`GET /workspaces/:id/scheduled`). */
export interface ScheduledChange {
  changeId: Hex;
  /**
   * What scheduled it: the proposal kind rotate-key, venues, policy or policy-revoke (a guarded batch, applied with
   * QEDOwnerAccount.applyCalls); remove-signers or set-thresholds (a change of the account itself, applied with
   * applyChange); or "recovery", a recovery started with a recovery key (finished with finishRecovery). Any one member
   * can cancel each of them until it is applied, except a removal by a member it removes.
   */
  kind: string;
  summary: string;
  status: "pending" | "applied" | "cancelled";
  calls: { target: Address; value: string; data: Hex; action: string }[];
  /** Unix seconds from which anyone may apply it; until then any one member can cancel it. */
  readyAt: number;
  readyTime: string;
  /** True when it is pending and the chain's next block is at or past readyAt. */
  ready: boolean;
  proposalId: string;
  jobId: string;
  appliedJobId: string | null;
  cancelledJobId: string | null;
  createdAt: string;
}

export type ProposalKind =
  | "provision" //        owner wires the deployed contracts: setAgent, setVenues
  | "mandate" //          owner signs a new mandate (EIP-712); the previous one is revoked on-chain
  | "policy" //           owner signs a standing treasury policy (EIP-191); the previous one is revoked
  | "policy-revoke" //    owner ends the standing policy
  | "convert" //          owner confirms one exact conversion tUSD → tEUR
  | "attack" //           Security Lab: owner confirms the genuine order one attack starts from
  | "scenario" //         one of the six configurable scenarios with fresh isolated roles
  | "pause" //            owner pauses the treasury vault
  | "guardian-pause" //   guardian pauses the treasury vault (cannot resume)
  | "resume" //           owner unpauses
  | "revoke-mandate" //   owner revokes one mandate on-chain without signing a new one
  | "void-all" //         owner bumps the vault epoch: every mandate and certificate becomes void
  | "rotate-key" //       owner replaces the operator, co-signer or guardian key
  | "pay" //              agent payment to an approved payee under the mandate and a co-signer certificate; with dueInDays a forward payment
  | "ring-fence" //       owner ring-fences free treasury funds for a creditor (irrevocable by the owner)
  | "withdraw" //         owner withdraws free treasury funds to the owner's own account
  | "deposit" //          owner deposits from the owner's own account into the treasury
  | "venues" //           owner names a new venue set out of the five deployed pools; older orders become void
  | "cancel-change" //    one member's passkey cancels a change scheduled behind the owner account's delay
  | "grant" //            owner adds to the agent's authority budget (R7 D7), as granted and not earned; no money moves
  | "earned-caps" //      owner signs the caps on earned authority (D-K1b): lower at once, higher after the account's delay
  | "add-signer" //       the admin threshold adds a member passkey or a recovery key to the owner account (immediate)
  | "remove-signers" //   the admin threshold schedules the removal of signers (after the delay; any other member can cancel)
  | "set-thresholds" //   the admin threshold sets both thresholds: raising is immediate, lowering waits the delay
  | "set-guardian" //     (R13) the admin threshold schedules a guardian (a recovery contact's passkey), or its removal, behind the delay
  | "set-time-lock" //    (R13) the admin threshold turns the time-lock of withdraw, ringFence, unpause, setGuardian on (at once) or off (after the delay)
  | "escrow-quote" //     the owner account, as provider, signs a work quote for the proof escrow (ERC-1271); no money moves
  | "escrow-fund" //      the client's owner account funds a quoted job from its own vault: withdraw, approve, open
  | "escrow-deliver" //   the provider's owner account delivers the certificate; the escrow pays the payee if it verifies
  | "escrow-release" //   the provider releases the client before the deadline: the escrow refunds the client
  // the review and dispute step in front of the proof escrow (QEDDisputeEscrow, R13 E3)
  | "escrow-accept" //    the client accepts verified work: the dispute escrow pays the provider in full
  | "escrow-dispute" //   the client disputes verified work within its review, with a reason (its hash on the chain)
  | "escrow-evidence" //  the client or the provider adds evidence to a dispute (its hash on the chain)
  | "escrow-decide" //    the named decider rules on a dispute: pay, refund or split, within its stated powers
  | "escrow-give-way" //  the provider refunds the client in full, after delivery or during a dispute
  // ownership and creditor operations of the release's QEDVault (R13 S5), each behind the owner account's delay
  | "transfer-ownership" // offers both vaults to a new owner (QEDVault.transferOwnership, guarded: scheduled)
  | "accept-ownership" //  this owner account accepts a vault offered to it (QEDVault.acceptOwnership)
  | "release-claim" //     as creditor, forgives a liability another vault ring-fenced for this account (scheduled)
  | "assign-claim"; //     as creditor, assigns such a liability to a new creditor (scheduled)

export interface ProposalRequest {
  kind: ProposalKind;
  params?: Record<string, unknown>;
}

export interface LimitCheck {
  id: string; //       stable identifier, e.g. "per-conversion", "mandate-period", "vault-daily"
  rule: string; //     wording shown to the owner
  limit: Raw | null;
  used: Raw | null;
  remaining: Raw | null;
  pass: boolean;
  detail?: string;
}

export interface Proposal {
  id: string;
  kind: ProposalKind;
  status: "open" | "used" | "expired" | "cancelled";
  /** The exact terms the owner authorises. Shown field by field; hashed as they are. */
  terms: Record<string, unknown>;
  termsHash: string;
  /** Human-readable one-line summary of the terms. */
  summary: string;
  /** False when the action would be refused under current limits; it may still be submitted to record the refusal. */
  allowed: boolean;
  checks: LimitCheck[];
  createdAt: string;
  expiresAt: string;
  genesisId: string;
  jobId?: string;
  network: string;
}

// ───────────────────────────── jobs, steps, outcomes ─────────────────────────────

export type StepStatus = "ok" | "refused" | "reverted" | "pending" | "info";
export interface Step {
  seq: number;
  key: string; // interpret | mandate | owner | cosigner | plan | submit | receipt | reconcile | decide | attack | clock | ...
  label: string;
  status: StepStatus;
  detail: string;
  data?: Record<string, unknown>;
  at: string;
}

/** "scheduled": an owner change that the account runs only after its delay (see ScheduledChange); nothing changed yet. */
export type Outcome = "executed" | "refused" | "reverted" | "no-action" | "error" | "scheduled" | "reorged";
export interface TxBrief {
  hash: Hex;
  status: "success" | "reverted";
  block: string;
  gasUsed: string;
  error?: string;
}

export interface OpResult {
  outcome: Outcome;
  summary: string;
  tx?: TxBrief;
  /** True when the transaction mined but balances did not reconcile: the caller must not retry. */
  doNotRetry?: boolean;
  evidence?: Record<string, unknown>;
}

export type JobStatus =
  | "accepted" //     stored durably, not started yet
  | "running"
  | "confirming" //   its transactions are mined and not yet deep enough (R7-036: rail/config.ts confirmations); not done yet
  | "done" //         finished, and every transaction it sent on the shared chain has the stated confirmations; see result.outcome
  | "failed" //       stopped before completion with an error; nothing further will happen
  | "interrupted" // the service stopped while it ran; resolved by lookup on the restored chain, never re-sent
  | "reorged"; //    a chain reorganisation replaced the block holding its transaction, before or after its confirmations; not done, never re-sent

export type JobKind = ProposalKind | "policy-tick" | "policy-run" | "economy" | "settle" | "apply-change" | "start-recovery" | "guardian-withdraw" | "sentinel-stop" | "freeze-signer" | "escrow-refund" | "escrow-finish" | "bounty-commit" | "bounty-reveal" | "bounty-settle";

export interface Job {
  id: string;
  kind: JobKind;
  status: JobStatus;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  proposalId: string | null;
  steps: Step[];
  result: OpResult | null;
  error: string | null;
  /** What to tell the owner when the status is uncertain. */
  guidance?: string;
  network: string;
  /**
   * R7-036: how deep the job's transactions on the shared chain are (the shallowest of them), against the depth a job
   * needs before it is reported done. Present once a transaction of the job has been mined.
   */
  confirmations?: { have: number; need: number; block: string | null };
}

export interface Accepted {
  jobId: string;
  kind: JobKind;
  status: JobStatus;
  /** True when this idempotency key was seen before with the same payload: the original job is returned. */
  duplicate: boolean;
}

// ───────────────────────────── treasury state ─────────────────────────────

export interface ClockReading {
  wallTime: string; //         ISO
  wallSeconds: number;
  chainSeconds: number; //     timestamp of the latest block
  /** wallSeconds − chainSeconds. Positive: the chain is behind (idle) and is brought forward. Negative: the chain is ahead. */
  skewSeconds: number;
  limitSeconds: number;
  /** False when the chain is ahead of the wall clock by more than the limit: every transaction is refused. */
  withinLimit: boolean;
}

export interface VaultView {
  address: Address;
  /** The vault's test token: tUSD or tEUR in the baseline; tINR, or another of the eight currencies' tokens (S5), in a workspace. */
  token: string;
  decimals: number;
  balance: Raw;
  ringFenced: Raw;
  free: Raw;
  dailyCap: Raw;
  spentInWindow: Raw;
  windowStart: number;
  availableToday: Raw;
  /** QEDLens.blastRadius(vault, 24 h): the most that can leave if the operator and co-signer keys are both stolen. */
  worstCaseLoss24h: Raw;
  worstCaseScope: string;
  paused: boolean;
  epoch: string;
  openLiabilities: string;
  owner: Address;
  agent: Address;
  cosigner: Address;
  guardian: Address;
}

/** The thirteen mandate fields, exactly as signed. */
export interface MandateFields {
  vault: Address;
  agent: Address;
  payees: Address[];
  maxPerPayment: Raw;
  maxPerPeriod: Raw;
  period: string;
  maxTotal: Raw;
  validFrom: string;
  validUntil: string;
  epoch: string;
  requireCosign: boolean;
  purpose: Hex;
  salt: Hex;
}

export interface MandateView {
  version: number;
  hash: Hex;
  status: "active" | "superseded" | "revoked" | "voided" | "expired";
  fields: MandateFields;
  payeeLabels: string[];
  purposeText: string;
  signedAt: string;
  approvalId: string | null;
  usage: {
    perPayment: { limit: Raw };
    period: { limit: Raw; spent: Raw; remaining: Raw; periodStart: number; seconds: number; note: string };
    lifetime: { limit: Raw; spent: Raw; remaining: Raw };
    validity: { validFrom: number; validUntil: number; active: boolean; secondsLeft: number };
    vaultDaily: { limit: Raw; spent: Raw; remaining: Raw; note: string };
    revokedOnChain: boolean;
    epochCurrent: boolean;
  };
}

export interface TrancheCandidates {
  need: Raw | null; //     smallest input whose certified output covers the shortfall; null if no allowed tranche can
  impact: Raw; //          largest input whose execution cost stays within the policy's limit
  policyCap: Raw;
  mandateCap: Raw;
  freeFunds: Raw;
}

export interface PolicyView {
  id: number;
  status: "active" | "superseded" | "revoked" | "expired";
  enforcement: "cosigner" | "contract";
  targetFree: Raw;
  minTranche: Raw;
  maxTranche: Raw;
  maxImpactBps: number;
  needSlackBps: number | null;
  validUntil: number;
  nonce: string;
  message: string;
  signedAt: string;
  ticks: number;
  reserveFree: Raw;
  shortfall: Raw;
  targetMet: boolean;
  policyContract: Address | null;
}

export interface VenueView {
  i: number;
  label: string;
  pool: Address;
  feeBps: number;
  token0: string;
  token1: string;
  r0: Raw;
  r1: Raw;
}

export interface PlanView {
  expectedOut: Raw;
  bound: Raw;
  gapPpm: number;
  sweeps: number;
  hops: { venue: number; label: string; tokenIn: string; tokenOut: string; amountIn: Raw; amountOut: Raw }[];
  /** The proof's price vector as the planner reports it: relative values per smallest unit of each token, floating-point numbers for display. They are not raw token amounts (the on-chain proof carries its own integers). */
  prices: Record<string, number>;
  alternatives: { policy: string; description: string; amountOut: Raw; shortfallBps: number; passesFloor: boolean | null }[];
}

export interface TradeView {
  at: string;
  instruction: string;
  amountIn: Raw;
  amountOut: Raw;
  bound: Raw;
  gapPpm: number;
  floor: Raw;
  tolerancePpm: number;
  hash: Hex;
  block: string;
  gasUsed: string;
  plan: PlanView;
  cosignerChecks: number;
  engine: string;
  jobId: string;
  /** What the co-signer signed for this conversion (R7-038): its floor and the certificate's validity window, enforced by the contract. Absent on a conversion made before it was kept. */
  executable?: import("./rail/quote-kinds.ts").ExecutableQuote;
  /** What the chain did, apart from the quote it was made under. */
  fill?: import("./rail/quote-kinds.ts").Fill;
}

export interface RailState {
  status: "starting" | "ready" | "failed" | "stopped";
  error: string | null;
  network: { chainId: number; name: string; block: string; timestamp: number; valueless: true; rpc: string };
  genesisId: string | null;
  /** The workspace these figures belong to, and how its owner's authority is held. */
  workspace: WorkspaceSummary;
  /** False until the owner approved the `provision` proposal. Nothing but reads and that proposal is possible before. */
  provisioned: boolean;
  startedAt: string;
  restoredFromState: boolean;
  clock: ClockReading;
  /** `attacker` is null for passkey workspaces: their Security Lab runs on ephemeral chains with throwaway keys. */
  roles: { owner: Address; ownerCustody: string; operator: Address; cosigner: Address; guardian: Address; attacker: Address | null; creditor: Address; cosignerIsolation: "separate-process" | "in-process" };
  contracts: { vault: Address; reserve: Address; execution: Address; lens: Address; tUSD: Address; tEUR: Address; tETH: Address; pools: Address[]; treasuryPolicy: Address | null; asset: Address; reserveAsset: Address; ownerAccount: Address | null };
  treasury: VaultView;
  reserve: VaultView;
  /** What the owner account itself holds, outside the vaults: escrow refunds and the owner's withdrawals land here
   *  (RISK-072). Base units of the workspace's asset and reserve asset, as decimal strings. */
  ownerHolds: { asset: string; reserveAsset: string };
  mandate: MandateView | null;
  policy: PolicyView | null;
  /** The venue set the owner has named on-chain. Empty until the `provision` proposal was approved and executed. */
  venues: VenueView[];
  /** Before provisioning: the five deployed pools the `provision` proposal will name. Empty once a venue set is named. */
  plannedVenues: VenueView[];
  lastTrade: TradeView | null;
  zkOptional: boolean;
}

/** One ring-fenced obligation of the treasury vault (`GET /liabilities`). Its funds can only reach `creditor`. */
export interface LiabilityView {
  id: string;
  creditor: Address;
  creditorLabel: string | null;
  amount: Raw;
  dueAt: number; //     unix seconds
  dueTime: string; //   ISO
  status: "open" | "settled" | "released";
  /** True when it is open and the chain's next block is at or past `dueAt`: anyone may settle it, also while paused. */
  due: boolean;
  createdBy: Address;
  createdByRole: "owner" | "agent" | "other"; // owner: QEDVault.ringFence; agent: a forward payment
  memo: Hex;
}

export type QuotaClass = "proposals" | "operations" | "economies";
/** The rail's own budget (`GET /workspaces/:id/quota`): a rolling window per class, stored durably. */
export interface QuotaView {
  windowSeconds: number;
  classes: { class: QuotaClass | "workspaces"; counts: string; limit: number; used: number; remaining: number; /** ISO time at which one more is allowed, or null while some remain. */ nextFreeAt: string | null }[];
  /** The host's budget over all workspaces together; a request must fit both. */
  global?: QuotaView;
}

// ───────────────────────────── workspaces (R7 D1, D3, D4) ─────────────────────────────

/** A member's passkey public key (P-256), hex. */
export interface PasskeyPublicKey { x: Hex; y: Hex }

/**
 * `POST /workspaces`. `owner` is one passkey, or several with a threshold (business workspaces). `workspaceId` is the
 * idempotency key: the same body again returns the same workspace; a different body is 409 workspace_exists.
 */
export interface CreateWorkspaceRequest {
  workspaceId: string;
  owner: PasskeyPublicKey | { signers: PasskeyPublicKey[]; threshold: number; adminThreshold?: number };
  /** sha256 of the WebAuthn relying-party id, hex (sha256("localhost") for the local wallet). */
  rpIdHash: Hex;
  /** Web origin the assertions come from; default "http://localhost:5175". */
  origin?: string;
  /** Recovery keys (raw P-256, derived client-side from recovery codes). Optional. */
  recovery?: PasskeyPublicKey[];
  /**
   * R13: start with the vaults' withdraw, ringFence, unpause and setGuardian time-locked (they then wait the account's
   * delay like guarded calls). Default false: they run at once, as before. Changeable later: on at once, off after the delay.
   */
  timeLock?: boolean;
  /**
   * Money-model S5: the workspace's test tokens, three different currencies of the eight the paper bank holds
   * (shared/chain-assets.ts). Absent, or the default spelt out (INR, USD, EUR): the tINR treasury, tUSD reserve and tEUR
   * route every workspace has had, and nothing needs signing. Any other set needs `authorization`.
   */
  currencies?: { treasury: string; reserve: string; route: string };
  /** Assertions over assetSetDigest(assetSetDocument(...)) by as many members as the account's admin threshold. */
  authorization?: { assertions: PasskeyAssertion[] };
}

export interface WorkspaceSummary {
  id: string;
  /** "awaiting-acceptance": deployed and configured, ownership offered to the owner account; the owner's `provision` approval accepts it. */
  status: "deploying" | "awaiting-acceptance" | "ready" | "failed";
  /** "passkey-account" for every workspace created through POST /workspaces; "release-development-owner" only for the
   *  baseline parity workspace. */
  ownerKind: "passkey-account" | "release-development-owner";
  ownerCustody: string;
  ownerAccount: Address | null;
  /** The owner-account build that was deployed, and whether chain/accounts had declared it ready. */
  ownerAccountBuild: { sha256: string; solc: string | null; declaredReady: boolean; label: string } | null;
  /** The owner account's signers as the chain holds them now (read again for every GET of the workspace). */
  signers: { signerId: Hex; x: Hex; y: Hex; role: "member" | "recovery" }[];
  threshold: number | null;
  /** Approvals a call to the account itself needs (adding or removing signers, thresholds); null for the development owner. */
  adminThreshold?: number | null;
  asset: { symbol: string; decimals: number; address: Address };
  reserveAsset: { symbol: string; decimals: number; address: Address };
  /**
   * Money-model S5: the workspace's currency set (shared/chain-assets.ts). `default` true for the set every workspace
   * had before S5, with `digest` null; otherwise `digest` is what the owner's passkeys signed at setup. Absent for the
   * baseline-parity workspace, which holds the release's tUSD and tEUR.
   */
  currencies?: { treasury: string; reserve: string; route: string; default: boolean; digest: Hex | null };
  /** The third test token, which a conversion may route through (tEUR by default). */
  routeAsset?: { symbol: string; decimals: number; address: Address };
  /** The opening grant from the host's faucet, in raw units, with its transactions; null until the owner accepted ownership. */
  grant: { vault: Raw; ownerAccount: Raw; token: string; txs: Hex[] } | null;
  /** The calls the owner account runs only after its delay (QEDOwnerAccount guards, fixed at deployment). */
  guards: { target: Address; selector: Hex; reason: string }[];
  createdAt: string;
}

export interface WorkspaceView extends WorkspaceSummary {
  contracts: { ownerAccount: Address | null; vault: Address; reserve: Address; execution: Address; treasuryPolicy: Address | null };
  keys: { agent: Address; guardian: Address; relayer: Address | null; derivation: string };
  duplicate?: boolean;
}

export interface LimitsResult {
  amount: Raw;
  allowed: boolean;
  checks: LimitCheck[];
  /** The largest amount every limit allows right now. An authorisation ceiling, not an executable quote. */
  maximum: Raw;
  execution: "none";
}

/**
 * The limit check for a payment from the treasury (`GET /payments/limits?amount=`): the conversion limits plus the
 * co-signer's check C12. A read: nothing is prepared, signed or sent.
 */
export interface PaymentLimits extends LimitsResult {
  /**
   * The co-signer's check C12 on its own. Under the release's rule (the baseline-parity workspace, or a workspace with
   * QED_RAIL_AUTHORITY=release): its allowance, what the vault has paid out against it, what is left. Under the
   * authority budget (R7 D7, every workspace by default): limit = granted + earned, used = limit − available,
   * remaining = what is available now; the full breakdown is in `authority`.
   */
  earned: { limit: Raw; used: Raw; remaining: Raw };
  /** Whether a signed mandate is in force. Without one the agent can pay nothing. */
  mandate: boolean;
  /** Present when C12 is the authority budget of R7 decision D7: the co-signer's own figures. */
  authority?: AuthorityView;
}

/**
 * The authority budget of one treasury vault (R7 decision D7; rail/authority-ledger.ts), as the co-signer computes it
 * from the chain, its owner-verified grants and the certificates it signed that are not used yet. Raw units of the
 * vault's own asset. available = granted + earned − used − held − reserved; it is what a payment or a conversion's
 * worst-case cost must fit in. Granted and earned are always reported apart: a grant is never earnings.
 */
export interface AuthorityView {
  rule: "d7";
  asset: { symbol: string; decimals: number };
  /** B0, the base every workspace starts with, and the owner's passkey-signed grants since. granted = base + grants. */
  base: Raw;
  grants: Raw;
  granted: Raw;
  /** r × escrow settlements paid to the workspace by clients outside its principal set, in its own asset, after k confirmations, within earnedLimit. */
  earned: Raw;
  /**
   * K1: earned authority counts at most perWindow in any windowSeconds of chain time, at most perPayer from any one
   * payer address, and nothing of what the workspace sent a payer before (netted, in the asset's raw units). inWindow:
   * earned in the window ending now. heldBack: what the caps kept from settlements that would otherwise have counted.
   */
  earnedLimit: { windowSeconds: number; perWindow: Raw; perPayer: Raw; inWindow: Raw; netted: Raw; heldBack: Raw };
  /** What has left the workspace's control at reference value: payments to others, conversions' realised costs, promises paid. */
  used: Raw;
  usedBy: { payments: Raw; conversions: Raw; promisesPaid: Raw };
  /** The agent's forward payments not yet paid or released. */
  held: Raw;
  /** Worst cases of certificates the co-signer signed that the chain has not used yet (until they expire or are voided). */
  reserved: Raw;
  budget: Raw;
  available: Raw;
  rate: string;
  confirmations: number;
  pendingCredits: number;
  notEarnings: number;
  /** Reference bands, in whole units of the vault's asset per one unit of each asset. */
  references: { symbol: string; lo: string; mid: string; hi: string; divergenceBps: number; source: string }[];
  /**
   * D-K1b: the earned-authority caps as the owner signed them. `ceiling` is the operator's (QED_RAIL_EARNED_*), `owner` the
   * owner's signed caps in force (null: none signed), `inForce` the lower of the two (what earnedLimit applies), `pending`
   * raises still waiting out their delay (`from`, ms). Present where C12 is the authority budget.
   */
  earnedCaps?: { ceiling: { windowSeconds: number; perWindow: Raw; perPayer: Raw }; owner: { perWindow: Raw | null; perPayer: Raw | null }; inForce: { perWindow: Raw; perPayer: Raw }; pending: { cap: "perWindow" | "perPayer"; value: Raw; from: number; nonce: string }[]; delaySeconds: number | null; signed: number };
  /** One plain sentence adding the figures up, in the vault asset's units. */
  statement: string;
  /** What the figures do not say. */
  limits: string[];
}

export interface QuoteResult {
  /** An indicative reading of the pools, not an executable quote and not a fill (rail/quote-kinds.ts). */
  kind: "indicative";
  allowed: boolean;
  checks: LimitCheck[];
  amountIn?: Raw;
  expectedOut?: Raw;
  bound?: Raw;
  gapPpm?: number;
  plan?: PlanView;
  /** Where the quote comes from and how fresh it is. */
  source: { provider: string; instrument: string; priceType: string; block: string; sourceTime: number; receivedAt: string; freshness: string };
  execution: "none";
  notice: string;
}

export interface HistoryEntry {
  n: number;
  at: string;
  kind: string;
  title: string;
  outcome: Outcome;
  tx?: TxBrief;
  trade?: { amountIn: Raw; amountOut: Raw; bound: Raw; gapPpm: number; hops: number; venues: number[] };
  jobId: string | null;
}

export interface TickRecord {
  n: number;
  at: string;
  policyId: number;
  action: "convert" | "wait" | "none";
  amountIn: Raw;
  shortfall: Raw;
  reserveFree: Raw;
  limitedBy: string | null;
  candidates: TrancheCandidates;
  reason: string;
  outcome: Outcome;
  jobId: string;
}

export interface DecisionRecord {
  n: number;
  at: string;
  kind: string;
  jobId: string | null;
  verdict: string;
  clock: ClockReading | null;
  approval: Approval | null;
  termsHash: string | null;
  /** The co-signer's canonical record, or the rail's own record for owner and guardian actions. */
  record: unknown;
  evidenceHash: string | null;
  prevHash: string;
  hash: string;
}

export interface AttackInfo {
  kind: "inferior-route" | "skim" | "forged-proof" | "single-pool" | "redirect" | "stolen-order";
  title: string;
  expect: string;
  layer: string;
}

export interface ScenarioInfo {
  tool: "portfolio" | "private_portfolio" | "clearing" | "payment" | "liability" | "execution_bounty" | "liability_due";
  label: string;
  available: boolean;
  unavailableReason?: string;
  bounds: string;
  schema: unknown;
  /** "release": one of the release's six tools (its workbench, unmodified). "rail": the rail's own time-moving scenario. */
  source: "release" | "rail";
  /** Every scenario runs on an ephemeral chain of its own, destroyed afterwards (R7 D4). */
  chain: "ephemeral";
}

export interface HistoricalEvidence {
  label: "HISTORICAL";
  network: string;
  explorer: string;
  note: string;
  transactions: { label: "HISTORICAL"; run: string; id: string; phase: string; title: string; hash: Hex; status: string; block: string; gas: string; error: string | null; expect: string | null }[];
  contracts: { label: "HISTORICAL"; name: string; address: Address; match: string }[];
  /** transactions and reverted: those named as steps (listed); inManifests: the runs' own totals, deployments and set-up included. */
  counts: { transactions: number; reverted: number; contracts: number; inManifests: { transactions: number; reverted: number } };
  excluded: string[];
}

export interface Health {
  status: "ok" | "starting" | "unavailable";
  ready: boolean;
  readiness: { rail: string; anvil: boolean; contracts: boolean; store: boolean; cosigner: boolean; vendored: boolean | null; checkedAt: string };
  /** "multi-tenant" (default) or "baseline-parity" (the release's development owner; parity tests only). */
  mode: "multi-tenant" | "baseline-parity";
  workspaces: number;
  /** The baseline workspace's provisioning (baseline-parity mode); false in multi-tenant mode. */
  provisioned: boolean;
  network: string;
  versions: { node: string; anvil: string | null; release: string };
}

/** One recorded clock event (`GET /clock`): a start, a restart, a detected gap, or a refusal. Fields vary by kind. */
export interface ClockEvent {
  n: number;
  at: string;
  kind: "start" | "restart" | "suspend" | "stall" | "clock-set-back" | "skew-refusal";
  /** For gaps: wall-clock and monotonic seconds between two heartbeats, and the chain time before and after. */
  wallSeconds?: number;
  monotonicSeconds?: number;
  chainBefore?: number;
  chainAfter?: number;
  blockMined?: boolean;
  note?: string;
  [extra: string]: unknown;
}

export interface EconomyInfo {
  scenario: "execution" | "economy" | "clearing" | "privacy";
  title: string;
  label: "SCRIPTED";
  available: boolean;
  takesInstruction: boolean;
  bundledManifest: string;
  running: boolean;
}

/** Results of the language routes (and of the functions of the same name in language/index.ts). */
export interface ScreenResult { refused: boolean; flags: string[]; dangerous: string[]; reply: string | null; engine: "deterministic security guard" }
export type ToolCallCheck = { ok: true; tool: string; mode: "read" | "treasury" | "scenario"; input: Record<string, unknown>; description: string } | { ok: false; error: string };

export interface ApiError {
  error: { code: string; message: string; details?: Record<string, unknown> };
}

// ───────────────────────────── the owner account's signers and recovery (RISK-053) ─────────────────────────────

/** `GET /workspaces/:id/signers`: the owner account's signers, thresholds and delays as the chain holds them now. */
export interface SignersView {
  account: Address;
  /** `frozen` (R13): the sentinel froze this member; its approval no longer counts for execute or ERC-1271. */
  signers: { signerId: Hex; x: Hex; y: Hex; role: "member" | "recovery" | "guardian"; serial: string; frozen: boolean; pendingRemoval: Hex | null; pendingRecovery: Hex | null }[];
  threshold: number;
  adminThreshold: number;
  memberCount: number;
  delaySeconds: number;
  recoveryDelaySeconds: number;
  /**
   * R13: the account's sentinel (lower-case address; zero address when it has none; null when its build predates R13),
   * whether it is this service's own sentinel key (so a suspension in the wallet can freeze a member at once), and
   * whether the account has `protect`.
   */
  containment: { sentinel: string | null; byThisService: boolean; protect: boolean };
  /**
   * R13 owner options. `supported` is false for an account built before them (it keeps its bytecode and gains nothing).
   * guardian: the passkey that must co-sign a recovery (null when none). timeLock: whether withdraw, ringFence, unpause
   * and setGuardian on the vaults wait the delay, and the calls it covers.
   */
  guardian: { supported: boolean; signerId: Hex | null; x: Hex | null; y: Hex | null };
  timeLock: { supported: boolean; on: boolean; calls: { target: Address; selector: Hex }[] };
  /** Pending changes of the signer set: removals, lowered thresholds, recoveries, the guardian, the time-lock (see ScheduledChange). */
  pending: ScheduledChange[];
  /** Every signer id the account has ever had (its SignerAdded events): a workspace sharing any of them is linked (R7 D7, A-ID). */
  everSigners: Hex[];
  rules: string[];
}

/** `GET /workspaces/:id/recovery/digest`: what a recovery key signs (raw P-256, ECDSA/SHA-256 over these 32 bytes). */
export interface RecoveryDigest {
  account: Address; chainId: number; recoverySignerId: Hex; newKey: { x: Hex; y: Hex }; newSignerId: Hex; deadline: string; digest: Hex; recoveryDelaySeconds: number; note: string;
  /** R13: the guardian whose passkey must sign this same digest (a WebAuthn assertion) for the recovery to start; null when the account has none. */
  guardian: { signerId: Hex; x: Hex; y: Hex } | null;
}

// ───────────────────────────── earning through the proof escrow (R7-054) ─────────────────────────────

/** A ProofEscrow quote as the rail returns it: integers as decimal strings. */
export interface EscrowQuote { provider: Address; payee: Address; client: Address; token: Address; price: Raw; verifier: Address; specHash: Hex; deliverBy: string; validUntil: string; quoteId: Hex }

/** One proof-escrow job this workspace is a party to (`GET /workspaces/:id/escrow/jobs`). */
export interface EscrowJobView {
  jobId: string;
  /** open: funded and waiting for a certificate; settled: the verifier accepted it and the payee was paid; refunded: returned to the client. */
  status: "open" | "settled" | "refunded";
  /** This workspace's part: client (its owner account funded it), provider (its owner account quoted it), payee (its vault is paid),
   *  decider (named by the dispute terms to rule on a dispute). With a dispute step, client and payee come from its terms. */
  roles: ("client" | "provider" | "payee" | "decider")[];
  client: Address; provider: Address; payee: Address; token: Address; price: Raw; priceText: string; verifier: Address; specHash: Hex; deliverBy: string; deliverByTime: string;
  quoteHash: Hex; solutionHash: Hex | null; resultDigest: Hex | null;
  /** True once the chain's time is past deliverBy and the job is still open: anyone may refund the client. */
  refundable: boolean;
  opened: { tx: Hex; block: string } | null; settled: { tx: Hex; block: string; confirmations: number } | null; refunded: { tx: Hex; block: string } | null;
  /** For the payee's side only: what the settlement does to this workspace's authority budget (R7 D7). */
  authority: { status: "credited" | "pending" | "not-earnings" | "not-settled"; credit: Raw; creditText: string; confirmations: number; needed: number; why: string } | null;
  /** The review and dispute step (QEDDisputeEscrow), when the job was opened through it; null otherwise. */
  dispute?: DisputeJobView | null;
}

/** A job of the dispute escrow, as the chain holds it. Times are unix seconds (0: not reached). Amounts are raw units. */
export interface DisputeJobView {
  disputeId: string; escrowJobId: string; escrow: Address;
  status: "funded" | "delivered" | "disputed" | "closed";
  outcome: "none" | "accepted" | "review-timeout" | "decided" | "decision-timeout" | "provider-gave-way" | "not-delivered";
  client: Address; provider: Address; payee: Address; decider: Address; price: Raw; priceText: string;
  terms: { deciderMay: { pay: boolean; refund: boolean; split: boolean }; reviewSeconds: number; evidenceSeconds: number; decisionSeconds: number; reviewTimeoutBps: number; decisionTimeoutBps: number; termsHash: Hex };
  deliveredAt: number; reviewEndsAt: number; disputedAt: number; evidenceEndsAt: number; decideBy: number; closedAt: number;
  toProvider: Raw; toClient: Raw;
  /** The client's reason and each side's evidence, as hashes on the chain, with the transaction of each. */
  reason: { hash: Hex; tx: Hex } | null;
  evidence: { by: "client" | "provider"; hash: Hex; tx: Hex }[];
  /** What may happen now, by the chain's time: who may act, and whether anyone may apply a timeout or a refund. */
  now: number; canAccept: boolean; canDispute: boolean; canAddEvidence: boolean; canDecide: boolean; canFinish: boolean; canReclaim: boolean;
}
