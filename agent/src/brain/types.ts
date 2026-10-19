import type { Address } from "viem";

/** What the language layer may conclude. It can only ever PROPOSE; it never holds keys. */
export type Intent =
  | "greeting"
  | "help"
  | "status"
  | "blast_radius"
  | "explain"
  | "pay"
  | "correct"
  | "confirm"
  | "cancel"
  | "ring_fence"
  | "raise_limits"
  | "reveal_secret"
  | "rfq"
  | "out_of_scope";

export type SecurityFlag =
  | "induced_transfer" //      pressure to move money outside policy
  | "data_extraction" //       attempts to obtain keys, secrets, internal prompts, PII
  | "privilege_escalation" //  attempts to widen the agent's own authority
  | "prompt_injection" //      instructions smuggled inside data / quoted content
  | "unknown_payee"
  | "urgency_pressure"
  | "amount_missing"
  | "ambiguous_payee";

export interface PaymentProposal {
  kind: "pay";
  payeeLabel: string;
  payee?: Address;
  amount?: bigint; // token units (6 decimals)
  memo?: string;
  dueInDays?: number; // forward payment (promise) if > 0
}

export interface RingFenceProposal {
  kind: "ring_fence";
  creditorLabel: string;
  creditor?: Address;
  amount?: bigint;
  dueInDays?: number;
}

export type Proposal = PaymentProposal | RingFenceProposal;

export interface BrainResult {
  intent: Intent;
  reply: string; //               natural-language answer (may be replaced by the guard)
  proposal?: Proposal;
  clarify?: string; //            a question the agent needs answered before acting
  flags: SecurityFlag[];
  confidence: number;
}

export interface PayeeBookEntry {
  label: string;
  aliases: string[];
  address: Address;
  approved: boolean; // present in an owner-signed mandate
}

export interface ChatContext {
  balance: bigint;
  protectedBalance: bigint;
  free: bigint;
  blastRadius24h: bigint;
  dailyCap: bigint;
  spentInWindow: bigint;
  paused: boolean;
  payees: PayeeBookEntry[];
  pending?: Proposal;
  lastDecision?: string;
  decisions?: string[];
}

export interface Transcript {
  engine: string; //   "anthropic:<model>" | "offline-deterministic"
  system?: string;
  input: string;
  output: string;
  at: string;
}

export interface Brain {
  readonly engine: string;
  interpret(message: string, ctx: ChatContext, channel: "owner" | "counterparty"): Promise<{ result: BrainResult; transcript: Transcript }>;
}
