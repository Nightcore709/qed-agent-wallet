/**
 * The release's language layer as importable modules, for the wallet backend:
 *
 *   import { screenMessage, validateToolCall, checkExplicitAmount, parseOffline, MODEL_TOOLS } from "../chain/language/index.ts";
 *
 *   (a) screenMessage(text)             run the deterministic guard BEFORE any model call; fixed refusal text
 *   (b) validateToolCall(name, input)   validate a model-proposed tool call against the nine-tool registry
 *       checkExplicitAmount(text, …)    refuse a call whose amount differs from the number the owner typed
 *   (c) parseOffline(text, ctx, cap)    the labelled deterministic parser plus guard, when no model is available
 *
 * Everything here is the release's own code, loaded unmodified from vendor/ (guard.ts, slots.ts, offline.ts,
 * evaluate.ts, capabilities.mjs, amount-lexing.mjs, knowledge.mjs). Nothing in it calls a network or holds a key.
 *
 * Loading on plain Node 26, with no loader flag and no build step: the vendored brain files are erasable
 * TypeScript, but they import their siblings as "./x.js". This module registers one synchronous resolve hook
 * (node:module registerHooks) that maps such a specifier to "./x.ts" ONLY when the importing file is inside
 * vendor/agent/src/brain/. It affects no other import of the host process. Under tsx the hook is a no-op.
 * The guard is defence in depth, never the binding control (the release says so too): authority stays in the
 * backend's own checks and, on the rail, in the contracts.
 */
import * as nodeModule from "node:module";
import { fileURLToPath } from "node:url";
import type { BrainResult, ChatContext, PayeeBookEntry, SecurityFlag } from "../vendor/agent/src/brain/types.ts";
import type { GuardedResult } from "../vendor/agent/src/brain/guard.ts";

export type { BrainResult, ChatContext, PayeeBookEntry, SecurityFlag, GuardedResult };

const BRAIN = new URL("../vendor/agent/src/brain/", import.meta.url).href;
type Resolve = (specifier: string, context: { parentURL?: string }) => unknown;
// registerHooks is newer than the pinned @types/node (22.10.2), hence the local signature.
const registerHooks = (nodeModule as unknown as { registerHooks?: (hooks: { resolve: (specifier: string, context: { parentURL?: string }, nextResolve: Resolve) => unknown }) => unknown }).registerHooks;
if (typeof registerHooks !== "function") throw new Error("The language layer needs node:module registerHooks (Node 22.15 or later), or run the host with --import tsx.");
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (context.parentURL?.startsWith(BRAIN) && specifier.startsWith("./") && specifier.endsWith(".js")) {
      try { return nextResolve(specifier, context); } catch { return nextResolve(`${specifier.slice(0, -3)}.ts`, context); }
    }
    return nextResolve(specifier, context);
  },
});

const vendored = (rel: string) => import(new URL(rel, import.meta.url).href);
const [guardModule, slotsModule, offlineModule, evaluateModule, capabilitiesModule, amountsModule, knowledgeModule] = await Promise.all([
  vendored("../vendor/agent/src/brain/guard.ts"), vendored("../vendor/agent/src/brain/slots.ts"), vendored("../vendor/agent/src/brain/offline.ts"), vendored("../vendor/agent/src/brain/evaluate.ts"),
  vendored("../vendor/agent/scripts/capabilities.mjs"), vendored("../vendor/agent/scripts/amount-lexing.mjs"), vendored("../vendor/agent/scripts/knowledge.mjs"),
]);

// ───────────── the release's exports, unchanged ─────────────
/** The four regular-expression detectors (English and Chinese). */
export const DETECTORS: Record<string, RegExp> = guardModule.DETECTORS;
export const scan: (text: string) => SecurityFlag[] = guardModule.scan;
export const guard: (raw: string, result: BrainResult, ctx: ChatContext, perPaymentCap: bigint) => GuardedResult = guardModule.guard;
export const resolvePayee: (label: string | undefined, book: PayeeBookEntry[]) => { entry?: PayeeBookEntry; raw?: string; ambiguous: boolean } = guardModule.resolvePayee;
export const rawTransferTargets: (raw: string, book: PayeeBookEntry[]) => { addresses: string[]; unapproved: string[]; namedUnknown?: string } = guardModule.rawTransferTargets;
export const extractAmount: (text: string) => bigint | undefined = slotsModule.extractAmount;
export const extractDueDays: (text: string, now?: Date) => number | undefined = slotsModule.extractDueDays;
export const extractPayeeLabel: (text: string, ctx: ChatContext) => string | undefined = slotsModule.extractPayeeLabel;
export const fillPaymentSlots: (raw: string, r: BrainResult, ctx: ChatContext) => BrainResult = slotsModule.fillPaymentSlots;
/** The labelled deterministic parser. Its `engine` is always "offline-deterministic". */
export const OfflineBrain: new () => { readonly engine: string; interpret(message: string, ctx: ChatContext, channel: "owner" | "counterparty"): Promise<{ result: BrainResult; transcript: { engine: string; input: string; output: string; at: string } }> } = offlineModule.OfflineBrain;
/** Scoring used by the red-team corpus: did the guarded result do the safe (or, for controls, the useful) thing? */
export const judge: (expect: "refuse_transfer" | "refuse_secret" | "refuse_escalation" | "allow" | "clarify", g: GuardedResult, ctx: ChatContext) => { pass: boolean; why: string } = evaluateModule.judge;

export interface Capability { label: string; mode: "read" | "treasury" | "scenario"; schema: { type: "object"; properties: Record<string, unknown>; required: string[]; additionalProperties: false } }
/** The nine typed tools with their exact JSON schemas. */
export const CAPABILITIES: Readonly<Record<string, Capability>> = capabilitiesModule.CAPABILITIES;
/** The same registry in the shape a model's tool-use API takes: { name, description, input_schema }. */
export const MODEL_TOOLS: { name: string; description: string; input_schema: Capability["schema"] }[] = capabilitiesModule.MODEL_TOOLS;
/** Throws with the release's message on an unknown tool, a missing or extra field, or a value out of range. */
export const validateCapability: (name: string, input: unknown) => any = capabilitiesModule.validateCapability;
export const describeCapability: (name: string, input: unknown) => string = capabilitiesModule.describeCapability;

export type AmountScan = { kind: "valid"; raw: bigint; text: string } | { kind: "none" | "invalid" | "ambiguous"; reason: string };
/** Exact parser: accepts 10, 22.5, 0.000001, $10, 1,000, 10tUSD; rejects .5, 1e2, 1_000, 0x10, signs, two numbers. */
export const scanAmount: (text: string) => AmountScan = amountsModule.scanAmount;
export const hasUnsafeSignedAmount: (text: string) => boolean = amountsModule.hasUnsafeSignedAmount;
/** Raw 6-decimal units to "1,234.50" without floating point. */
export const formatMicro: (raw: bigint | string | number) => string = amountsModule.formatMicro;

export interface KnowledgeTopic { path: string; label: string; answer: string }
/** Ten fixed, evidence-scoped topics. `path` is the old page's anchor; map it to the new navigation. */
export const KNOWLEDGE: Readonly<Record<string, KnowledgeTopic>> = knowledgeModule.KNOWLEDGE;
export const identifyKnowledgeTopic: (message: string) => string | null = knowledgeModule.identifyKnowledgeTopic;

// ───────────── the three uses the backend needs ─────────────
export const OFFLINE_ENGINE = "offline-deterministic";
export const DANGEROUS_FLAGS: SecurityFlag[] = ["privilege_escalation", "data_extraction", "prompt_injection", "induced_transfer"];
/** Fixed wording of the release's conversation layer (agent/scripts/conversation.mjs:48-50, :88-89, :83). */
export const TEXTS = {
  refusal: (flags: string[]) => `Request refused (${flags.join(", ")}). No tool ran and nothing was signed. Owner permissions and secrets cannot be changed through chat.`,
  cancelled: "Unsubmitted proposals in this tab were cancelled. Already accepted transactions are unaffected.",
  chatIsNotConsent: "Use the confirmation button on the exact proposal. A chat message cannot replace financial consent.",
  malformedAmount: "The monetary number is malformed. Use exact positive decimal notation.",
  amountChanged: "The model changed your explicit amount. Please restate it; no proposal was created.",
  questionNotAction: "This is a question, so no financial action was proposed. Ask for an explicit action if you want to review one.",
  unsupportedTool: "Unsupported capability. No arbitrary scripts, destinations or RPC endpoints are accepted.",
} as const;

/**
 * (a) Run this on the raw message before any model call. `refused` means: answer with `reply`, call no model, run
 * no tool. The engine label to show is "deterministic security guard".
 */
export function screenMessage(message: string): { refused: boolean; flags: SecurityFlag[]; dangerous: SecurityFlag[]; reply: string | null; engine: "deterministic security guard" } {
  const flags = scan(message);
  const dangerous = flags.filter((f) => DANGEROUS_FLAGS.includes(f));
  return { refused: dangerous.length > 0, flags, dangerous, reply: dangerous.length ? TEXTS.refusal(dangerous) : null, engine: "deterministic security guard" };
}

/** Chat words that are never consent, and the cancel words (conversation.mjs:49-50). */
export const isChatConsent = (message: string) => /^\s*(yes|confirm|go ahead|do it|execute it)\s*[.!]?$/i.test(message);
export const isCancel = (message: string) => /^\s*(cancel|never mind|dismiss|stop)\s*[.!]?$/i.test(message);
/** A question or hypothetical never becomes an action (conversation.mjs:58). */
export const isQuestion = (message: string) => /^\s*(why|what|how|when|where|who|which|explain|describe|compare|tell me)\b/i.test(message) || /\b(would|what if|could i|can i)\b/i.test(message);

export type ToolCallCheck = { ok: true; tool: string; mode: Capability["mode"]; input: any; description: string } | { ok: false; error: string };
/** (b) Validate a tool call a model proposed. Model output is untrusted until it has passed here. */
export function validateToolCall(name: string, input: unknown): ToolCallCheck {
  try {
    const normalised = validateCapability(name, input);
    return { ok: true, tool: name, mode: CAPABILITIES[name].mode, input: normalised, description: describeCapability(name, normalised) };
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
}

const AMOUNT_TOOLS = ["convert", "quote_conversion", "payment", "liability", "execution_bounty"];
/**
 * The owner's number governs (conversation.mjs:85-90): when the message holds one exact amount and a single proposed
 * tool call carries a different one, the call is refused; a malformed number in the message refuses every such call.
 */
export function checkExplicitAmount(message: string, calls: { name: string; input: { amount?: unknown } }[]): { ok: true } | { ok: false; error: string } {
  const explicit = scanAmount(message);
  for (const call of calls) {
    if (!AMOUNT_TOOLS.includes(call.name)) continue;
    if (explicit.kind === "invalid") return { ok: false, error: TEXTS.malformedAmount };
    const proposed = typeof call.input?.amount === "string" ? scanAmount(call.input.amount) : { kind: "invalid" as const };
    if (calls.length === 1 && explicit.kind === "valid" && (proposed.kind !== "valid" || proposed.raw !== explicit.raw)) return { ok: false, error: TEXTS.amountChanged };
  }
  return { ok: true };
}

/**
 * (c) The labelled fallback when no model is configured or a call failed: the deterministic parser, then the guard.
 * Always report `engine` ("offline-deterministic") with the answer; it never counts as model-assisted.
 */
export async function parseOffline(message: string, ctx: ChatContext, perPaymentCap: bigint): Promise<{ engine: typeof OFFLINE_ENGINE; guarded: GuardedResult; dangerous: SecurityFlag[] }> {
  const { result } = await new OfflineBrain().interpret(message, ctx, "owner");
  const guarded = guard(message, result, ctx, perPaymentCap);
  return { engine: OFFLINE_ENGINE, guarded, dangerous: guarded.flags.filter((f) => DANGEROUS_FLAGS.includes(f)) };
}

export const VENDORED_FROM = fileURLToPath(new URL("../vendor/agent/", import.meta.url));
