/**
 * OfflineBrain — a deterministic natural-language layer used when no LLM API key is configured.
 * It is intentionally transparent (rules, not magic) and is always labelled "offline-deterministic"
 * in transcripts and evidence. It shares the same interface as the LLM brain, and everything it
 * produces still passes through the Guard, the co-signer and the vault contract.
 */
import { formatUnits, type Address } from "viem";
import { scan } from "./guard.js";
import type { Brain, BrainResult, ChatContext, Intent, Proposal, Transcript } from "./types.js";

const usd = (x: bigint) => `${Number(formatUnits(x, 6)).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })} tUSD`;

import { extractAmount, extractDueDays, extractPayeeLabel } from "./slots.js";
export { extractAmount, extractDueDays, extractPayeeLabel };

function classify(text: string, ctx: ChatContext, channel: "owner" | "counterparty"): Intent {
  const t = text.trim();
  if (channel === "counterparty") return "rfq";
  if (ctx.pending && /^(yes|yep|yeah|confirm(ed)?|approve(d)?|go ahead|do it|ok(ay)?|sure|proceed)\b/i.test(t)) return "confirm";
  if (ctx.pending && /^(no|nope|cancel|stop|abort|never ?mind|don'?t)\b/i.test(t)) return "cancel";
  if (ctx.pending && /(actually|make it|change (it|that|the amount)|instead|i meant|sorry)/i.test(t)) return "correct";
  if (ctx.pending && extractAmount(t) !== undefined && !/\b(pay|send|transfer|wire|schedule)\b/i.test(t)) return "correct";
  if (/(blast radius|worst[- ]case|(hacked|compromised|stolen)|how much (can|could) (you|we|i) lose|max(imum)? loss)/i.test(t)) return "blast_radius";
  // moving money INTO a payee that is itself a vault (e.g. the euro reserve) is a payment — a conversion when
  // that vault holds another currency — not a ring-fence inside this vault
  if (/\b(convert|move|top up|put|sweep|exchange|swap)\b.{0,80}\b(reserve|t?eur|euros?)\b/i.test(t) && !/(ring-?fence|set aside|earmark)/i.test(t)) return "pay";
  if (/(ring-?fence|set aside|earmark|reserve\b|lock (up|away))/i.test(t)) return "ring_fence";
  if (/\b(pay|send|transfer|wire|settle|tip|reimburse|remit|schedule)\b/i.test(t)) return "pay";
  if (/(balance|how much|free|available|protected|status|funds|treasury|owe|liabilit|reserves?)/i.test(t)) return "status";
  if (/\b(why|explain|reason|what did you|how did you)\b/i.test(t)) return "explain";
  if (/(portfolio|variance|optimi[sz]|markowitz|quote|\bjob\b|rfq)/i.test(t)) return "rfq";
  if (/^(hi|hello|hey|good (morning|afternoon|evening)|yo)\b/i.test(t)) return "greeting";
  if (/(help|what can you do|commands|capabilit)/i.test(t)) return "help";
  return "out_of_scope";
}

export class OfflineBrain implements Brain {
  readonly engine = "offline-deterministic";

  async interpret(message: string, ctx: ChatContext, channel: "owner" | "counterparty") {
    const flags = scan(message);
    const intent = classify(message, ctx, channel);
    let reply = "";
    let proposal: Proposal | undefined;
    let clarify: string | undefined;

    switch (intent) {
      case "greeting":
        reply = `Hi. I'm QED, your treasury agent. Free: ${usd(ctx.free)} · ring-fenced: ${usd(ctx.protectedBalance)} · 24h blast radius: ${usd(ctx.blastRadius24h)}. Ask me to pay an approved payee, explain a decision, or quote a portfolio job.`;
        break;
      case "help":
        reply =
          "I can: report balances and protected liabilities; tell you exactly how much could be lost if my keys were stolen; pay approved payees (with your confirmation, an independent co-signer certificate and on-chain checks); draft ring-fences and mandate changes for you to sign; quote and deliver certified portfolio optimisations. I can't move money to unapproved addresses, raise my own limits, or reveal keys.";
        break;
      case "status":
        reply = `Vault balance ${usd(ctx.balance)}: ${usd(ctx.protectedBalance)} ring-fenced for creditors (untouchable, even by the owner) and ${usd(ctx.free)} free. Spent in the current 24h window: ${usd(ctx.spentInWindow)} of ${usd(ctx.dailyCap)}.${ctx.paused ? " I am currently PAUSED by the guardian." : ""}`;
        break;
      case "blast_radius":
        reply = `If my AI key AND the co-signer key were both stolen right now, the most that could leave the vault in the next 24h is ${usd(ctx.blastRadius24h)} — and only to payees you approved. Loss to any address you didn't approve: exactly 0. The ${usd(ctx.protectedBalance)} ring-fenced for creditors cannot move anywhere except to those creditors. This bound is computed on-chain by blastRadius(), not by me.`;
        break;
      case "explain": {
        const ds = ctx.decisions ?? (ctx.lastDecision ? [ctx.lastDecision] : []);
        const words = message.toLowerCase().match(/[a-z]{4,}/g) ?? [];
        let best = ds[ds.length - 1];
        let bestScore = 0;
        for (const d of ds) {
          const dl = d.toLowerCase();
          const score = words.filter((w) => dl.includes(w)).length;
          if (score > bestScore) [best, bestScore] = [d, score];
        }
        reply = best ?? "I haven't made a payment decision in this session yet. Every decision I make is written to a decision record whose hash is anchored on-chain in the payment event.";
        break;
      }
      case "pay":
      case "correct": {
        const amount = extractAmount(message);
        const label = extractPayeeLabel(message, ctx);
        const base = ctx.pending?.kind === "pay" ? ctx.pending : undefined;
        proposal = {
          kind: "pay",
          payeeLabel: label ?? base?.payeeLabel ?? "",
          payee: undefined,
          amount: amount ?? (intent === "correct" ? base?.amount : undefined),
          dueInDays: extractDueDays(message) ?? (intent === "correct" ? base?.dueInDays : undefined),
          memo: message.slice(0, 120),
        };
        if (!proposal.payeeLabel) {
          clarify = `Who should I pay? Approved payees: ${ctx.payees.filter((p) => p.approved).map((p) => p.label).join(", ")}.`;
          proposal = { ...proposal, payeeLabel: "" };
        }
        reply = clarify ?? "";
        break;
      }
      case "confirm":
        reply = "Confirmed. Requesting an independent co-signer certificate and executing on-chain.";
        proposal = ctx.pending;
        break;
      case "cancel":
        reply = "Cancelled. Nothing was signed or sent.";
        break;
      case "ring_fence": {
        const amount = extractAmount(message);
        const label = extractPayeeLabel(message, ctx) ?? "the creditor";
        proposal = { kind: "ring_fence", creditorLabel: label, amount, dueInDays: extractDueDays(message) };
        break;
      }
      case "rfq":
        reply = channel === "counterparty" ? "Request for quote received." : "Portfolio jobs arrive from client agents as RFQs; I quote them automatically when the economics and solvency checks pass.";
        break;
      default:
        reply =
          "That's outside what I do. I manage this vault's payments, protected liabilities and certified portfolio jobs. Try: \"what's our free balance?\", \"pay the data vendor 5\", or \"what's your blast radius?\"";
    }

    const result: BrainResult = { intent, reply, proposal, clarify, flags, confidence: intent === "out_of_scope" ? 0.3 : 0.9 };
    const transcript: Transcript = { engine: this.engine, input: message, output: JSON.stringify(result, (_, v) => (typeof v === "bigint" ? v.toString() : v)), at: new Date().toISOString() };
    return { result, transcript };
  }
}

export const _test = { classify };
export type { Address };
