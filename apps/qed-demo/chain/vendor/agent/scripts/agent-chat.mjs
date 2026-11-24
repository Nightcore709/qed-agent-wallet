import { scanAmount, hasUnsafeSignedAmount, formatMicro } from './amount-lexing.mjs';
import { identifyKnowledgeTopic, KNOWLEDGE } from './knowledge.mjs';
export { hasUnsafeSignedAmount } from './amount-lexing.mjs';
/**
 * QED agent chat — separates questions from transactions.
 *
 *   explain / status / "would this be allowed?"  → answered from live sandbox state, no transaction
 *   "convert 10 tUSD to tEUR"                     → a PROPOSAL: language layer + guard + signed-limit check.
 *                                                  Nothing executes until the owner confirms (POST /api/sandbox/convert).
 *   anything else                                 → the QED language layer (Anthropic when configured, otherwise the
 *                                                  labelled offline parser) behind the deterministic guard.
 *
 * Explanations are grounded: the model (when configured) may only rephrase FACTS read from the chain; without a model
 * the deterministic explainer answers from the same facts. The engine that answered is always reported.
 */
const fmt = formatMicro;
const MODEL = process.env.LLM_MODEL ?? "claude-sonnet-5-5";
let llmCalls = 0;
const MAX_LLM = Number(process.env.QED_MAX_LLM_CALLS ?? 400);
const llmEnabled = () => !!process.env.ANTHROPIC_API_KEY && process.env.QED_OFFLINE !== "1" && llmCalls < MAX_LLM;

/** Parse exactly one monetary number or refuse rather than silently changing it. */
export function parseAmount(text) {
  const s=scanAmount(text);
  if(s.kind==='valid') return {raw:s.raw,text:s.text};
  if(s.kind==='none') return null;
  return s.kind==='ambiguous' ? {ambiguous:true} : {invalid:true};
}

const TOPICS = [
  ["target", /\b(reserve target|target|standing policy|policy)\b/i],
  ["last", /\b(why|how).*(last|previous|that|the) (trade|conversion|transaction)|last trade|last conversion/i],
  ["certificate", /\b(certificate|proof|bound|dual|best[- ]execution|optimal|optimality|ppm)\b/i],
  ["worse", /\b(worse|inferior|bad|suboptimal|malicious|compromised|attack|skim|cheat|steal)\b/i],
  ["cosigner", /\b(co-?signer|second key|independent)\b/i],
  ["mandate", /\b(mandate|limit|cap|allowed|permission|authori[sz])/i],
  ["balance", /\b(balance|how much|holdings|reserve|treasury|funds|status|available|spent)\b/i],
  ["how", /\b(how does|how do|what is qed|what does|explain|works?)\b/i],
];

function facts(st) {
  return {
    network: st.network?.name,
    treasury_tUSD: { balance: fmt(st.treasury.balance), free: fmt(st.treasury.free), ringFenced: fmt(st.treasury.ringFenced), spentToday: fmt(st.treasury.spentInWindow), availableToday: fmt(st.treasury.availableToday) },
    euroReserve_tEUR: { balance: fmt(st.reserve.balance), free: fmt(st.reserve.free) },
    mandate: { version: st.mandate.version, maxPerConversion_tUSD: fmt(st.mandate.maxPerPayment), maxPerDay_tUSD: fmt(st.mandate.maxPerPeriod), coSignatureRequired: true, payees: st.mandate.payees },
    standingPolicy: st.policy ? { keepFree_tEUR: fmt(st.policy.targetFree), tranche_tUSD: `${fmt(st.policy.minTranche)}–${fmt(st.policy.maxTranche)}`, maxExecutionCostBps: st.policy.maxImpactBps, ticksSoFar: st.policy.ticks } : "none signed yet",
    lastTrade: st.lastTrade ? { instruction: st.lastTrade.instruction, in_tUSD: fmt(st.lastTrade.amountIn), out_tEUR: fmt(st.lastTrade.amountOut), onchainBound_tEUR: fmt(st.lastTrade.bound), gapPpm: Number(st.lastTrade.gapPpm).toFixed(3), floor_tEUR: fmt(st.lastTrade.floor), tolerancePpm: st.lastTrade.tolerancePpm, txHash: st.lastTrade.hash, block: st.lastTrade.block, cosignerChecks: st.lastTrade.cosignerChecks, hops: st.lastTrade.plan?.hops?.length, prices: st.lastTrade.plan?.prices } : "no trade yet in this sandbox session",
    recentEvents: (st.history || []).slice(0, 5).map((h) => `${h.outcome}: ${h.title}`),
  };
}

function explainDeterministic(topic, st) {
  if (KNOWLEDGE[topic]) return KNOWLEDGE[topic].answer;
  const f = facts(st);
  const lt = st.lastTrade;
  switch (topic) {
    case "target":
      return st.policy
        ? `The owner's standing policy keeps at least ${fmt(st.policy.targetFree)} tEUR free in the euro reserve. It has ${fmt(st.reserve.free)} tEUR free now, so the shortfall is ${fmt(BigInt(st.policy.targetFree) > BigInt(st.reserve.free) ? BigInt(st.policy.targetFree) - BigInt(st.reserve.free) : 0n)} tEUR. Each tick the agent converts X = min(need, impact limit, policy cap, mandate cap, free funds) and stops once the target is met; the co-signer re-derives X before it signs.`
        : `No standing policy is signed in this sandbox yet. In Treasury, sign one as the sandbox owner (for example "keep 30 tEUR free"), then run policy ticks: the agent decides each tranche itself and stops at the target. The euro reserve holds ${fmt(st.reserve.free)} tEUR free now.`;
    case "last":
      return lt
        ? `The last trade (${lt.instruction}) executed because every gate passed: it was within mandate v${st.mandate.version} (≤ ${fmt(st.mandate.maxPerPayment)} tUSD), the co-signer ran ${lt.cosignerChecks} checks and signed an order with floor ${fmt(lt.floor)} tEUR, and on-chain QEDExecution accepted it: ${fmt(lt.amountIn)} tUSD → ${fmt(lt.amountOut)} tEUR against a bound of ${fmt(lt.bound)} (${Number(lt.gapPpm).toFixed(3)} ppm, within τ = ${lt.tolerancePpm} ppm). Transaction ${lt.hash.slice(0, 12)}… in block ${lt.block} of the local sandbox chain.`
        : "No trade has run in this sandbox session yet. Ask me to convert an amount (for example “Convert 10 tUSD to tEUR”) and confirm it as the owner.";
    case "certificate":
      return `The agent sends its route together with one price per token (ν). For constant-product venues, weak duality says no route through the owner's venues can return more than B(ν) = ν·A + Σ venue terms, each in closed form from live reserves. QEDExecution recomputes B(ν) from the reserves in the same transaction, rounding every step upward, and accepts only if output·10⁶ ≥ B·(10⁶ − τ), with τ = 1 ppm. A wrong ν only loosens the bound, so a proof cannot be forged; an honest agent finds ν where the bound meets the optimum.${lt ? ` Last trade: ${fmt(lt.amountOut)} tEUR out, bound ${fmt(lt.bound)}, gap ${Number(lt.gapPpm).toFixed(3)} ppm.` : ""} The bound covers the owner-approved venues only, not all of DeFi.`;
    case "worse":
      return "If the agent submits a worse route — a single-pair route, a 5% skim of one leg, a forged price vector — the realised output falls below the on-chain bound and QEDExecution reverts with NotBestExecution, even though the trade would clear a 1% slippage floor. Redirecting the output fails with OrderMismatch (the co-signer signed the order hash), and calling without the agent key fails with NotOperator. Try each one in the Security Lab: they are sent as real transactions and mined as reverts.";
    case "cosigner":
      return `The co-signer is a separate process with its own key. It never trusts the agent: for each conversion it re-reads the chain, re-quotes the optimal route itself, screens venue prices for manipulation, checks the owner's signed instruction and the mandate, and only then signs an order with a floor. The vault refuses any payment without both the owner's mandate and this co-signature.`;
    case "mandate":
      return `The owner's signed mandate v${st.mandate.version} allows at most ${fmt(st.mandate.maxPerPayment)} tUSD per conversion and ${fmt(st.mandate.maxPerPeriod)} tUSD a day, to three payees only (the conversion module, the euro reserve, CloudCo), and requires the co-signer. ${fmt(st.treasury.availableToday)} tUSD is left in today's window. The AI cannot change any of this; in the sandbox the owner can sign a new mandate in Treasury.`;
    case "balance":
      return `Treasury: ${fmt(st.treasury.balance)} tUSD (${fmt(st.treasury.free)} free, ${fmt(st.treasury.ringFenced)} ring-fenced), ${fmt(st.treasury.spentInWindow)} spent today. Euro reserve: ${fmt(st.reserve.balance)} tEUR (${fmt(st.reserve.free)} free). Read from the sandbox chain at block ${st.network.block}; valueless test tokens.`;
    default:
      return "QED lets an AI agent move money only inside what the owner signed. I interpret your request and propose; a separate co-signer re-derives every decision; the contracts enforce the mandate, caps and ring-fenced liabilities, and for conversions they check a mathematical proof that the route got within 1 ppm of the best any route over the owner's venues could give. Try “Convert 10 tUSD to tEUR”, “Would 80 tUSD violate my mandate?” or “Explain the best-execution certificate”.";
  }
  void f;
}

async function explainLLM(question, st, topic) {
  llmCalls++;
  const r = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "x-api-key": process.env.ANTHROPIC_API_KEY, "anthropic-version": "2023-06-01", "content-type": "application/json" },
    signal: AbortSignal.timeout(20_000),
    body: JSON.stringify({
      model: MODEL,
      max_tokens: 520,
      system:
        "You are QED's explainer inside a testnet treasury app. Answer the user's question in at most 110 words of plain, natural prose (never mention 'FACTS', JSON or field names), using ONLY the FACTS JSON, optional VERIFIED_MECHANISM context, and these mechanics: owner-signed EIP-712 mandate; independent co-signer that re-derives every decision; QEDExecution checks on-chain that output ≥ (1 − τ) × a dual upper bound B(ν) computed from live reserves of the owner's constant-product venues (τ = 1 ppm); worse routes revert with NotBestExecution. Never invent numbers, hashes or balances not in FACTS. Never offer to bypass limits, reveal keys or execute anything: execution happens only when the owner confirms in the app. All tokens are valueless test tokens on a local sandbox chain.",
      messages: [{ role: "user", content: `FACTS:\n${JSON.stringify(facts(st))}\n\nVERIFIED_MECHANISM (historical/scripted, not live chat execution):\n${KNOWLEDGE[topic]?.answer ?? "No additional mechanism facts."}\n\nQUESTION:\n${question}` }],
    }),
  });
  if (!r.ok) throw new Error(`Anthropic API ${r.status}`);
  const data = await r.json();
  return data.content?.map((c) => c.text ?? "").join("").trim();
}

export async function agentReply(sandbox, message) {
  if (sandbox.status !== "ready") return { kind: "unavailable", engine: "none", reply: sandbox.status === "starting" ? "The sandbox chain is still starting. Try again in a few seconds." : "The sandbox chain is unavailable right now; historical Sepolia evidence is still available under Evidence.", execution: "none" };
  const st = await sandbox.state();
  const lower = message.toLowerCase();
  // Never read dates, proofs, transaction IDs or benchmark figures as a spend
  // amount. Financial operations and explicit tUSD amount questions are the
  // only cases where the strict monetary parser is relevant.
  const verb = /\b(convert|move|swap|exchange|top ?up|put|transfer|send|buy)\b/i.test(message);
  // "Why did we convert 20?" is a question about a prior action, not a
  // request to propose a fresh conversion.
  const informational = /^\s*(?:what|why|how|when|where|who|which|explain|show|describe|compare|tell me)\b/i.test(message);
  const actionRequest = verb && !informational;
  const hypothetical = /\b(would|whether|what if|could|can i|is it (?:ok|allowed|possible)|violate|exceed|break|is (?:this|that|it|the amount) allowed)\b/i.test(message);
  const financialCheck=/\b(?:tusd|test\s*dollars?)\b/i.test(message)&&hypothetical;
  // Explanations with several historic amounts are never parsed as a new payment.
  const moneyContext=actionRequest||financialCheck;
  let amt = moneyContext ? parseAmount(message) : null;
  if (amt?.invalid || amt?.ambiguous) return {kind: "clarify", engine: "QED input validator", reply: "Use one positive, unsigned amount in tUSD (for example, Convert 10 tUSD to tEUR). Malformed, negative, or explicitly signed amounts are not accepted. Use one exact positive number, such as 0.5 tUSD. No transaction was proposed or submitted.", execution: "none"};
  // 1 · the language layer and guard see every message first: escalation and secret requests are refused here
  const { g, transcript } = await sandbox.interpret(message);
  const engine = transcript.engine;
  const dangerous = (g.flags || []).filter((f) => ["privilege_escalation", "data_extraction", "prompt_injection", "induced_transfer"].includes(f));
  if (dangerous.length || ["reveal_secret", "raise_limits"].includes(g.intent)) {
    return { kind: "refusal", engine, intent: g.intent, flags: g.flags, reply: `${g.reply} (Flagged: ${dangerous.join(", ") || g.intent}. Nothing was signed or sent; only the owner can change a signed mandate.)`, execution: "none" };
  }

  const maxRequest = /\b(?:maximum|max|largest|most)\b/i.test(message) &&
    /\b(?:convert|conversion|swap|exchange|spend|tusd|amount)\b/i.test(message) && !amt;
  let maximum = maxRequest ? [st.mandate.maxPerPayment, st.treasury.free, st.treasury.availableToday].map(BigInt).reduce((a,b)=>a<b?a:b) : null;
  if (maxRequest && maximum>0n) {
    // The live co-signer's reserve buffer and any other current constraints
    // are already calculated by Sandbox.checkLimits. Do not infer them here.
    const check=await sandbox.checkLimits(maximum);
    for(const c of check.checks)if(!c.pass&&c.limit!=null){const cap=BigInt(c.limit);if(cap<maximum)maximum=cap;}
    if(maximum<0n)maximum=0n;
  }
  if(maxRequest && !actionRequest){
    return {kind:"answer",engine:"deterministic limit check (chain state)",execution:"none",
      reply:`The largest amount permitted by the current per-conversion cap, free treasury funds and remaining daily allowance is ${fmt(maximum)} tUSD. This is an authorization ceiling, not a guaranteed executable quote: actual liquidity, the co-signer and the execution proof are checked at submission. To prepare that amount, ask \"Convert the maximum allowed amount\".`};
  }
  if(maxRequest && actionRequest){
    if(maximum<=0n)return {kind:"refusal",engine:"deterministic limit check (chain state)",execution:"none",reply:"There is no currently spendable tUSD under the signed limits and free balance. No transaction was proposed."};
    amt={raw:maximum,text:fmt(maximum)};
  }

  // An amount written in words ("twenty-two and a half dollars") is taken from the language model's structured
  // reading, only when the model (not the offline parser) produced it and the text has no digits to contradict it.
  let amountSource = maxRequest && actionRequest ? "current signed limits and spendable balance" : "your text";
  if (!amt && !/\d/.test(message) && engine.startsWith("anthropic") && g.proposal?.amount > 0n) {
    amt = { raw: BigInt(g.proposal.amount), text: fmt(g.proposal.amount) };
    amountSource = "Claude's reading of your words";
  }

  // 2 · "would X violate my mandate?" — a check, never a transaction
  if (amt?.raw && hypothetical) {
    const lim = await sandbox.checkLimits(amt.raw);
    return { kind: "check", engine: "deterministic limit check (chain state)", amount: amt.raw, allowed: lim.allowed, checks: lim.checks, reply: lim.allowed ? `Yes: ${fmt(amt.raw)} tUSD is within every signed limit right now. Nothing has been sent; ask me to convert it and confirm as the owner to execute.` : `No: converting ${fmt(amt.raw)} tUSD would be refused before any signature — ${lim.checks.filter((c) => !c.pass).map((c) => `${c.rule.toLowerCase()} is ${fmt(c.limit)} tUSD`).join("; ")}. The AI cannot raise these limits.`, execution: "none" };
  }

  // 3 · a conversion request — a proposal awaiting the owner's confirmation
  if (actionRequest && (amt || /\b(teur|eur|euro|reserve)\b/i.test(message))) {
    if (!amt) return { kind: "clarify", engine, reply: "How much? Give one amount in tUSD, for example “Convert 10 tUSD to tEUR”.", execution: "none" };
    if (amt.ambiguous) return { kind: "clarify", engine, reply: "I see more than one amount. Give exactly one amount in tUSD so nothing is ambiguous.", execution: "none" };
    const p = g.proposal;
    const toReserve = (p && p.kind === "pay" && p.payeeLabel && /euro|reserve/i.test(p.payeeLabel)) || /\b(t?eur|euros?|reserve)\b/i.test(message) || (maxRequest && /\bconvert\b/i.test(message));
    if (!toReserve) return { kind: "clarify", engine, reply: `The owner's mandate authorises conversions from the tUSD treasury into the euro reserve only. ${g.reply}`, execution: "none" };
    // the owner's own number governs, even if the language layer suggested a smaller one
    const proposal = { amount: amt.raw };
    const lim = await sandbox.checkLimits(proposal.amount);
    // what the owner confirms is exactly the amount shown: a canonical instruction when the amount came from words
    const instruction = amountSource === "your text" && message.length >= 4 ? message : `Convert ${fmt(proposal.amount).replace(/,/g, "")} tUSD to tEUR`;
    return {
      kind: "proposal",
      engine,
      amount: proposal.amount,
      allowed: lim.allowed,
      checks: lim.checks,
      instruction,
      reply: lim.allowed
        ? `${engine.startsWith("anthropic") ? "Claude" : "The offline parser"} reads this as: convert ${fmt(proposal.amount)} tUSD into the euro reserve (amount from ${amountSource}). It is within the signed limits. Confirm as the owner to send it through the co-signer and on-chain proof check.`
        : `I read this as converting ${fmt(proposal.amount)} tUSD, but it breaks the signed limits: ${lim.checks.filter((c) => !c.pass).map((c) => `${c.rule.toLowerCase()} (${fmt(c.limit)} tUSD)`).join("; ")}. I cannot raise them. You can still submit it to see the refusal, or sign a new mandate as the owner in Treasury.`,
      execution: "awaiting owner confirmation",
    };
  }

  // 4 · questions, answered from chain state
  const topic = identifyKnowledgeTopic(message) || (TOPICS.find(([, re]) => re.test(lower)) || [null])[0];
  if (topic || ["help", "status", "blast_radius", "explain", "greeting"].includes(g.intent)) {
    const t = topic || (g.intent === "status" || g.intent === "blast_radius" ? "balance" : "how");
    if (llmEnabled()) {
      try {
        const text = await explainLLM(message, st, t);
        if (text) return { kind: "answer", topic: t, engine: `anthropic:${MODEL} (grounded in verified data)`, reply: text, execution: "none", action: KNOWLEDGE[t] && {href:KNOWLEDGE[t].path,label:KNOWLEDGE[t].label} };
      } catch (e) {
        return { kind: "answer", topic: t, engine: `deterministic explainer (model unavailable: ${String(e.message).slice(0, 60)})`, reply: explainDeterministic(t, st), execution: "none", action: KNOWLEDGE[t] && {href:KNOWLEDGE[t].path,label:KNOWLEDGE[t].label} };
      }
    }
    return { kind: "answer", topic: t, engine: "deterministic explainer (verified evidence / chain state)", reply: explainDeterministic(t, st), execution: "none", action: KNOWLEDGE[t] && {href:KNOWLEDGE[t].path,label:KNOWLEDGE[t].label} };
  }

  return { kind: "answer", engine, intent: g.intent, reply: g.reply, execution: "none" };
}
