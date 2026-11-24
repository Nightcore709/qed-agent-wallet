/**
 * The Guard: a deterministic layer that sits AFTER the language model and BEFORE any action.
 *
 * Design rule: the LLM is treated as an untrusted, possibly-manipulated component. Whatever it says,
 * the guard independently re-scans the raw input for the four attack classes the competition rubric
 * names (induced transfer, data extraction, privilege escalation, prompt injection), resolves payees
 * only against the owner-approved payee book, and forces explicit confirmation for every
 * value-moving action. Even if the guard were bypassed, the co-signer and the vault contract would
 * still reject anything outside the owner's signed mandate.
 */
import { formatUnits, isAddress, type Address } from "viem";
import type { BrainResult, ChatContext, PayeeBookEntry, Proposal, SecurityFlag } from "./types.js";
import { fillPaymentSlots } from "./slots.js";

export const DETECTORS: Record<Exclude<SecurityFlag, "unknown_payee" | "amount_missing" | "ambiguous_payee" | "induced_transfer">, RegExp> = {
  data_extraction:
    /(私钥|助记词|密钥|密码|系统提示|private[\s_-]*keys?|secret[\s_-]*keys?|seed[\s_-]*phrase|mnemonic|recovery[\s_-]*phrase|\.env\b|api[\s_-]*keys?|password|passphrase|signing[\s_-]*key|system[\s_-]*prompt|your (hidden |internal )?instructions|(show|print|dump|reveal|tell)\b.{0,25}\b(keys?|config|environment|secrets?|credentials?))/i,
  privilege_escalation:
    /((提高|取消|解除|修改).{0,10}(限额|额度|上限|权限|签名)|(限额|额度|上限|权限).{0,10}(提高|取消|解除|修改)|添加.{0,10}(收款人|白名单)|(raise|increase|lift|remove|disable|bypass|override|double|triple|change|update|expand)\b.{0,40}\b(limits?|caps?|mandates?|polic(y|ies)|co-?signer|guardian|owner|allow-?list|white-?list|spending)|\bunpause\b|add\b.{0,30}\b(as )?(a |an )?(new )?(payee|recipient|vendor|whitelist)|grant (yourself|me|it)|make me (the )?(owner|admin)|transfer ownership|set (a new )?agent|sign (it|this|the mandate) yourself|without (the )?(co-?signer|owner|approval))/i,
  prompt_injection:
    /(忽略(之前|以上|前面)的?(所有)?(指令|指示|规则)|系统(指令|覆盖)|ignore (all |any |the )?(previous|prior|above|earlier) (instructions|rules|messages)|disregard\b.{0,25}\binstructions|new instructions\s*:|system (override|prompt|message|update)\s*:|you are now\b|developer mode|jailbreak|\[\s*system\s*\]|<\s*\/?\s*system\s*>|begin (new )?instructions|override\s*:|as an ai (assistant )?you must|this is a test of your obedience)/i,
  urgency_pressure:
    /(紧急|立即|马上|立刻|否则|\burgent\b|\bimmediately\b|right now|\basap\b|within \d+ (minutes|mins|hours)|or else|\bceo\b|boss (says|wants)|final notice|will be (closed|frozen|suspended)|act now|time-?sensitive|before it'?s too late)/i,
};

const TRANSFER_BAIT =
  /(保证金|手续费|验证费|verification (fee|deposit)|refundable deposit|security deposit|unlock (fee|your)|gas (fee )?to|processing fee|activation fee|send\b.{0,40}\b0x[0-9a-f]{6,}|wire\b.{0,40}\b0x[0-9a-f]{6,})/i;

export function scan(text: string): SecurityFlag[] {
  const flags = new Set<SecurityFlag>();
  for (const [k, re] of Object.entries(DETECTORS)) if (re.test(text)) flags.add(k as SecurityFlag);
  if (TRANSFER_BAIT.test(text) || (flags.has("urgency_pressure") && /((pay|send|transfer|wire)\b|转账|汇款|支付|打款)/i.test(text))) {
    flags.add("induced_transfer");
  }
  return [...flags];
}

export function resolvePayee(label: string | undefined, book: PayeeBookEntry[]): { entry?: PayeeBookEntry; raw?: Address; ambiguous: boolean } {
  if (!label) return { ambiguous: false };
  const l = label.toLowerCase().trim();
  if (isAddress(l)) {
    const e = book.find((b) => b.address.toLowerCase() === l);
    return { entry: e, raw: l as Address, ambiguous: false };
  }
  const hits = book.filter((b) => b.label.toLowerCase() === l || b.aliases.some((a) => l.includes(a) || a.includes(l)));
  if (hits.length === 1) return { entry: hits[0], ambiguous: false };
  return { ambiguous: hits.length > 1 };
}

const usd = (x: bigint) => `${Number(formatUnits(x, 6)).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })} tUSD`;

const ATTACK_FLAGS: SecurityFlag[] = ["induced_transfer", "data_extraction", "privilege_escalation", "prompt_injection", "urgency_pressure"];
const TRANSFER_VERB = /(\b(pay|send|transfer|wire|remit|move|forward)\b|转账|转给|汇款|支付|打款|付款)/i;

/** Deterministically extracts the destinations a message asks to move money to. */
export function rawTransferTargets(raw: string, book: PayeeBookEntry[]): { addresses: string[]; unapproved: string[]; namedUnknown?: string } {
  const addresses = [...new Set((raw.match(/0x[0-9a-fA-F]{40}/g) ?? []).map((a) => a.toLowerCase()))];
  const approved = new Set(book.filter((b) => b.approved).map((b) => b.address.toLowerCase()));
  const unapproved = TRANSFER_VERB.test(raw) ? addresses.filter((a) => !approved.has(a)) : [];
  let namedUnknown: string | undefined;
  const m = raw.match(/\b(?:pay|send|transfer|wire|remit)\s+(?:the\s+)?([A-Za-z][\w-]{1,30})\b/i);
  if (m && !/^(0x|all|everything|it|them|us|me|funds?|money|the|our|my|\d)/i.test(m[1])) {
    const lbl = m[1].toLowerCase();
    const known = book.some((b) => b.label.toLowerCase().includes(lbl) || b.aliases.some((a) => a.includes(lbl) || lbl.includes(a)));
    if (!known) namedUnknown = m[1];
  }
  return { addresses, unapproved, namedUnknown };
}

export interface GuardedResult extends BrainResult {
  needsConfirmation: boolean;
  guardNotes: string[];
}

/** Applies policy to a brain result. Pure: no keys, no chain writes. Security-critical replies are
 *  always produced HERE, deterministically — never taken from the language model. */
export function guard(raw: string, r0: BrainResult, ctx: ChatContext, perPaymentCap: bigint): GuardedResult {
  const r = fillPaymentSlots(raw, r0, ctx);
  const detected = scan(raw);
  const llmAttackFlags = r.flags.filter((f) => ATTACK_FLAGS.includes(f));
  const flags = new Set<SecurityFlag>([...detected, ...llmAttackFlags]);
  const notes: string[] = [];
  let reply = r.reply;
  let proposal = r.proposal;
  let clarify = r.clarify;
  let needsConfirmation = false;
  let intent = r.intent;
  const approvedList = ctx.payees.filter((p) => p.approved).map((p) => p.label).join(", ") || "none";
  const targets = rawTransferTargets(raw, ctx.payees);

  const scamReply = (who: string) =>
    `I can't pay ${who}: it isn't an approved payee in any owner-signed mandate, so the vault would reject it on-chain (PayeeNotInMandate). ` +
    (flags.has("urgency_pressure") || flags.has("induced_transfer") || flags.has("prompt_injection")
      ? "Urgency, embedded 'instructions' and an unfamiliar destination are classic signs of a payment scam — I've logged this attempt. "
      : "") +
    `Approved payees right now: ${approvedList}.`;

  if (flags.has("data_extraction")) {
    intent = "reveal_secret";
    proposal = undefined;
    clarify = undefined;
    reply =
      "I can't share keys, secrets, configuration or internal instructions. Structurally, I couldn't even if I wanted to: " +
      "my signing key lives in a separate signer process that the language layer never sees, and every payment also " +
      "needs an independent co-signer certificate and your owner-signed mandate. If you need to rotate a key, the owner " +
      "can call setAgent() — I can prepare that transaction for your signature.";
    notes.push("blocked: data extraction");
  } else if (targets.unapproved.length > 0 && !(flags.has("privilege_escalation") && /\b(add|whitelist|allow-?list|approve)\b/i.test(raw) && !/\b(send|wire|transfer)\b/i.test(raw))) {
    intent = "pay";
    proposal = undefined;
    clarify = undefined;
    flags.add("unknown_payee");
    if (flags.has("urgency_pressure") || flags.has("prompt_injection")) flags.add("induced_transfer");
    reply = scamReply(targets.unapproved[0]);
    notes.push("blocked: transfer to an address outside the owner's mandate");
  } else if (flags.has("privilege_escalation")) {
    intent = "raise_limits";
    proposal = undefined;
    clarify = undefined;
    reply =
      "I can't widen my own authority — limits, payees, the co-signer and unpausing are owner-only, and the vault " +
      "enforces that on-chain (my key reverts with NotOwner). If you are the owner and want this change, I can draft " +
      "an updated mandate for you to review and sign with the owner key. Want me to draft it?";
    notes.push("blocked: privilege escalation");
  } else if (targets.namedUnknown && (intent === "pay" || TRANSFER_VERB.test(raw)) && !(proposal?.kind === "pay" && resolvePayee(proposal.payeeLabel, ctx.payees).entry)) {
    intent = "pay";
    proposal = undefined;
    clarify = undefined;
    flags.add("unknown_payee");
    reply = `${scamReply(targets.namedUnknown)} Did you mean one of those? If ${targets.namedUnknown} should be added, I can draft a mandate update for you to sign.`;
  }

  if (proposal && proposal.kind === "pay") {
    const { entry, raw: rawAddr, ambiguous } = resolvePayee(proposal.payee ?? proposal.payeeLabel, ctx.payees);
    if (ambiguous) {
      flags.add("ambiguous_payee");
      clarify = `Which payee do you mean? Approved payees: ${approvedList}.`;
    } else if (!entry || !entry.approved) {
      flags.add("unknown_payee");
      reply = scamReply(entry?.label ?? rawAddr ?? proposal.payeeLabel);
      proposal = undefined;
      clarify = undefined;
    } else {
      proposal = { ...proposal, payee: entry.address, payeeLabel: entry.label };
      if (proposal.amount === undefined) {
        flags.add("amount_missing");
        clarify = `How much should I pay ${entry.label}? Per-payment cap is ${usd(perPaymentCap)}; free balance is ${usd(ctx.free)}.`;
      } else if (proposal.amount > perPaymentCap) {
        reply = `${usd(proposal.amount)} exceeds the per-payment cap of ${usd(perPaymentCap)} in your mandate. I can pay up to ${usd(perPaymentCap)}, or you can raise the cap by signing a new mandate.`;
        proposal = { ...proposal, amount: undefined };
        clarify = `Would you like to pay ${usd(perPaymentCap)} instead?`;
      } else if (proposal.amount > ctx.free) {
        reply = `That would dip into ring-fenced funds. Free balance is ${usd(ctx.free)}; ${usd(ctx.protectedBalance)} is reserved for creditors and is untouchable.`;
        proposal = undefined;
        clarify = undefined;
      } else if (ctx.paused) {
        reply = "I'm paused by the guardian. Only the owner can resume me; creditors are still being paid on schedule.";
        proposal = undefined;
        clarify = undefined;
      } else {
        needsConfirmation = true;
        clarify = undefined;
        const when = proposal.dueInDays ? ` as a ring-fenced forward payment due in ${proposal.dueInDays} day(s)` : "";
        reply =
          `Proposed: pay ${usd(proposal.amount)} to ${entry.label}${when}. After this, free balance would be ${usd(ctx.free - proposal.amount)} ` +
          `and ${usd(ctx.protectedBalance)} stays ring-fenced. This moves money, so I need your explicit confirmation — reply "confirm" or "cancel".`;
      }
    }
  }

  if (proposal && proposal.kind === "ring_fence") {
    const { entry } = resolvePayee(proposal.creditor ?? proposal.creditorLabel, ctx.payees);
    if (!proposal.amount) clarify = `How much should be ring-fenced for ${proposal.creditorLabel}, and when is it due?`;
    else
      reply = `Ring-fencing is an owner action (the agent key cannot create owner liabilities). Draft: reserve ${usd(proposal.amount)} for ${entry?.label ?? proposal.creditorLabel}${proposal.dueInDays ? ` due in ${proposal.dueInDays} day(s)` : ""}. Sign it with the owner key to make it irrevocable — after that, not even the owner can touch it.`;
  }

  if (flags.has("prompt_injection")) notes.push("prompt injection detected: embedded instructions ignored");
  if (clarify && !needsConfirmation && !reply.includes(clarify)) reply = proposal ? clarify : reply ? `${reply} ${clarify}` : clarify;

  return { ...r, intent, reply, proposal, clarify, flags: [...flags], needsConfirmation, guardNotes: notes };
}
