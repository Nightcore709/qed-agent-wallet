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
const fmt = (raw) => (Number(raw) / 1e6).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 6 });
const MODEL = process.env.LLM_MODEL ?? "claude-sonnet-5-5";
let llmCalls = 0;
const MAX_LLM = Number(process.env.QED_MAX_LLM_CALLS ?? 400);
const llmEnabled = () => !!process.env.ANTHROPIC_API_KEY && process.env.QED_OFFLINE !== "1" && llmCalls < MAX_LLM;

/** One tUSD amount, strictly: "10", "22.5 tUSD", "$5". Several different amounts are ambiguous. */
export function parseAmount(text) {
  const ms = [...text.matchAll(/(?:\$\s*)?\b(\d{1,7}(?:\.\d{1,6})?)\s*(?:t?usd|dollars?|\$)?(?![\d.])/gi)].map((m) => m[1]);
  const uniq = [...new Set(ms.map((x) => Number(x)))].filter((x) => Number.isFinite(x));
  if (uniq.length !== 1) return uniq.length ? { ambiguous: true } : null;
  const [w, f = ""] = String(ms[0]).split(".");
  return { raw: BigInt(w) * 1_000_000n + BigInt(f.padEnd(6, "0")), text: ms[0] };
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

async function explainLLM(question, st) {
  llmCalls++;
  const r = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "x-api-key": process.env.ANTHROPIC_API_KEY, "anthropic-version": "2023-06-01", "content-type": "application/json" },
    signal: AbortSignal.timeout(20_000),
    body: JSON.stringify({
      model: MODEL,
      max_tokens: 400,
      system:
        "You are QED's explainer inside a testnet treasury app. Answer the user's question in at most 110 words of plain prose, using ONLY the FACTS JSON and these mechanics: owner-signed EIP-712 mandate; independent co-signer that re-derives every decision; QEDExecution checks on-chain that output ≥ (1 − τ) × a dual upper bound B(ν) computed from live reserves of the owner's constant-product venues (τ = 1 ppm); worse routes revert with NotBestExecution. Never invent numbers, hashes or balances not in FACTS. Never offer to bypass limits, reveal keys or execute anything: execution happens only when the owner confirms in the app. All tokens are valueless test tokens on a local sandbox chain.",
      messages: [{ role: "user", content: `FACTS:\n${JSON.stringify(facts(st))}\n\nQUESTION:\n${question}` }],
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
  let amt = parseAmount(message);
  const verb = /\b(convert|move|swap|exchange|top ?up|put|transfer|send|buy)\b/i.test(message);
  const hypothetical = /\b(would|whether|what if|could|can i|is it (?:ok|allowed|possible)|violate|exceed|break|allowed)\b/i.test(message);

  // 1 · the language layer and guard see every message first: escalation and secret requests are refused here
  const { g, transcript } = await sandbox.interpret(message);
  const engine = transcript.engine;
  const dangerous = (g.flags || []).filter((f) => ["privilege_escalation", "data_extraction", "prompt_injection", "induced_transfer"].includes(f));
  if (dangerous.length || ["reveal_secret", "raise_limits"].includes(g.intent)) {
    return { kind: "refusal", engine, intent: g.intent, flags: g.flags, reply: `${g.reply} (Flagged: ${dangerous.join(", ") || g.intent}. Nothing was signed or sent; only the owner can change a signed mandate.)`, execution: "none" };
  }

  // An amount written in words ("twenty-two and a half dollars") is taken from the language model's structured
  // reading, only when the model (not the offline parser) produced it and the text has no digits to contradict it.
  let amountSource = "your text";
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
  if (verb && (amt || /\b(teur|eur|euro|reserve)\b/i.test(message))) {
    if (!amt) return { kind: "clarify", engine, reply: "How much? Give one amount in tUSD, for example “Convert 10 tUSD to tEUR”.", execution: "none" };
    if (amt.ambiguous) return { kind: "clarify", engine, reply: "I see more than one amount. Give exactly one amount in tUSD so nothing is ambiguous.", execution: "none" };
    const p = g.proposal;
    const toReserve = (p && p.kind === "pay" && p.payeeLabel && /euro|reserve/i.test(p.payeeLabel)) || /\b(t?eur|euros?|reserve)\b/i.test(message);
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
  const topic = (TOPICS.find(([, re]) => re.test(lower)) || [null])[0];
  if (topic || ["help", "status", "blast_radius", "explain", "greeting"].includes(g.intent)) {
    const t = topic || (g.intent === "status" || g.intent === "blast_radius" ? "balance" : "how");
    if (llmEnabled()) {
      try {
        const text = await explainLLM(message, st);
        if (text) return { kind: "answer", topic: t, engine: `anthropic:${MODEL} (grounded in chain state)`, reply: text, execution: "none" };
      } catch (e) {
        return { kind: "answer", topic: t, engine: `deterministic explainer (model unavailable: ${String(e.message).slice(0, 60)})`, reply: explainDeterministic(t, st), execution: "none" };
      }
    }
    return { kind: "answer", topic: t, engine: "deterministic explainer (chain state)", reply: explainDeterministic(t, st), execution: "none" };
  }

  return { kind: "answer", engine, intent: g.intent, reply: g.reply, execution: "none" };
}
