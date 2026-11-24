/**
 * Deterministic slot filling for anything that moves money. The language model handles conversation;
 * payee, amount, date, confirm and cancel are extracted and tracked HERE, by code, so a payment can
 * never depend on how a model happened to phrase or interpret a turn.
 */
import { parseUnits } from "viem";
import type { BrainResult, ChatContext, PaymentProposal } from "./types.js";

const WEEKDAYS = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];

export function extractAmount(text: string): bigint | undefined {
  const t = text.replace(/0x[0-9a-fA-F]{6,}/g, " "); // never read digits out of addresses
  const m =
    t.match(/\$\s*(\d{1,9}(?:\.\d{1,6})?)/) ??
    t.match(/(\d{1,9}(?:\.\d{1,6})?)\s*(?:t?usd|usdc|dollars?|bucks)\b/i) ??
    t.match(/\b(?:pay|send|transfer|wire|make it|change it to|to|reserve|set aside|ring-?fence)\s+(?:\w+\s+){0,3}?(\d{1,9}(?:\.\d{1,6})?)\b(?!\s*(?:days?|hours?|minutes?))/i);
  if (!m) return undefined;
  try {
    return parseUnits(m[1], 6);
  } catch {
    return undefined;
  }
}

export function extractDueDays(text: string, now = new Date()): number | undefined {
  const m = text.match(/(?:due|in|within)\s+(\d{1,3})\s*days?/i);
  if (m) return Number(m[1]);
  if (/next week/i.test(text)) return 7;
  if (/tomorrow/i.test(text)) return 1;
  const wd = WEEKDAYS.findIndex((d) => new RegExp(`\\b(by |on |due )?${d}\\b`, "i").test(text));
  if (wd >= 0) {
    const diff = (wd - now.getUTCDay() + 7) % 7;
    return diff === 0 ? 7 : diff;
  }
  return undefined;
}

export function extractPayeeLabel(text: string, ctx: ChatContext): string | undefined {
  const addr = text.match(/0x[0-9a-fA-F]{40}/);
  if (addr) return addr[0];
  const lower = text.toLowerCase();
  for (const p of ctx.payees) {
    if (lower.includes(p.label.toLowerCase()) || p.aliases.some((a) => lower.includes(a))) return p.label;
  }
  const m = text.match(/\b(?:pay|send|transfer|wire|to|for)\s+(?:the\s+)?([A-Z][\w-]{2,}(?:\s+[A-Z][\w-]+)?)/);
  return m?.[1];
}


const CONFIRM = /^\s*(yes|yep|yeah|confirm(ed)?|approve(d)?|go ahead|do it|ok(ay)?|sure|proceed|确认|好的?|是的?)\b/i;
const CANCEL = /^\s*(no|nope|cancel|stop|abort|never ?mind|don'?t|取消|不要)\b/i;
const PAY_VERB = /(\b(pay|send|transfer|wire|remit|schedule|tip|reimburse)\b|支付|付款|转账)/i;

/** Completes or overrides the model's view of a payment turn using deterministic extraction. */
export function fillPaymentSlots(raw: string, r: BrainResult, ctx: ChatContext): BrainResult {
  const pending = ctx.pending?.kind === "pay" ? ctx.pending : undefined;
  if (pending && CONFIRM.test(raw)) return { ...r, intent: "confirm", proposal: pending, clarify: undefined };
  if (pending && CANCEL.test(raw)) return { ...r, intent: "cancel", proposal: undefined, clarify: undefined };

  const amount = extractAmount(raw);
  const label = extractPayeeLabel(raw, ctx);
  const due = extractDueDays(raw);
  const isPayTurn = PAY_VERB.test(raw);
  const isCorrection = !!pending && !isPayTurn && (amount !== undefined || !!label || /(actually|instead|make it|i meant|change)/i.test(raw));

  if (!isPayTurn && !isCorrection) return r;

  const base: PaymentProposal =
    r.proposal?.kind === "pay" ? r.proposal : isCorrection && pending ? pending : { kind: "pay", payeeLabel: "" };
  const proposal: PaymentProposal = {
    ...base,
    payeeLabel: label ?? (base.payeeLabel || (isCorrection ? pending!.payeeLabel : "")),
    payee: label ? undefined : base.payee ?? (isCorrection ? pending!.payee : undefined),
    amount: amount ?? base.amount ?? (isCorrection ? pending!.amount : undefined),
    dueInDays: due ?? base.dueInDays ?? (isCorrection ? pending!.dueInDays : undefined),
    memo: base.memo ?? raw.slice(0, 120),
  };
  const clarify = !proposal.payeeLabel
    ? `Who should I pay? Approved payees: ${ctx.payees.filter((p) => p.approved).map((p) => p.label).join(", ")}.`
    : r.clarify;
  return { ...r, intent: isCorrection ? "correct" : "pay", proposal, clarify };
}
