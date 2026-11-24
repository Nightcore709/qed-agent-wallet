/**
 * Evidence-scoped, non-executable catalogue of the mechanisms documented in
 * QED Pitch Deck (FinTechathon 2026) and docs/EVIDENCE.md.
 * Historic figures are labelled; scripts are not represented as live chat tools.
 */
export const KNOWLEDGE = Object.freeze({
  limits: {
    path:'#treasury', label:'Inspect signed limits',
    answer:'The owner sets a signed per-payment cap, daily cap, approved destinations and expiry. The co-signer checks each proposed conversion independently, and the vault contract enforces the mandate. To change a limit, the sandbox owner must sign a new mandate in Treasury; the AI cannot change it.'
  },
  security: {
    path:'#lab', label:'Open Security Lab',
    answer:'QED separates the agent, owner, independent co-signer and on-chain enforcement. The original Sepolia evidence documents 48 adversarial attempts and 48 reverts. Those are historical testnet outcomes, not new actions in this chat. The Security Lab can reproduce supported isolated attacks with actual local reverted transactions. Protected creditor funds cannot be redirected by the agent or co-signer.'
  },
  portfolio: {
    path:'#services', label:'Explore certified portfolio optimization',
    answer:'QED solves a minimum-variance portfolio off-chain and supplies a KKT certificate. Contracts check portfolio constraints, stationarity, complementary slackness, a convexity witness and an optimality tolerance in exact integers. The pitch deck documents the successful Sepolia escrow settlement for proof-backed work. The Economies page runs the existing complete, fixed-input scenario on its own disposable local chain; this chat does not submit arbitrary custom portfolio jobs.'
  },
  escrow: {
    path:'#services', label:'Explore escrow and paid work',
    answer:'The paid-work economy follows request → signed quote → escrow funding → authorized vendor payment → portfolio optimization → mathematical certificate → verification → settlement. Historic Sepolia evidence records a 15 tUSD proof-backed settlement and rejected invalid work, as well as a refund path. Economies offers a genuine fixed-input script that deploys and exercises the existing contracts. This conversational answer is read-only.'
  },
  clearing: {
    path:'#services', label:'Explore certified clearing',
    answer:'The certified clearing scenario describes five agents with 200 tUSD gross debt across 11 obligations and only 28 tUSD cash. A net-position-preserving, mathematically maximal netting certificate clears 169 tUSD, leaving 31 tUSD to settle. Those figures are from the documented scenario, not your live treasury. The Economies page exposes a reproducible fixed-input local scenario, including rejection of non-maximal clearing.'
  },
  privacy: {
    path:'#services', label:'Explore zero-knowledge proof',
    answer:'QED uses Groth16 to prove a portfolio satisfies the optimality conditions for a vendor-attested private risk model. Public commitments and verification inputs are on-chain; the covariance entries, portfolio weights and KKT witness remain private. The pitch deck documents a historical 12 tUSD proof-backed settlement and three rejected counterfeits. Economies offers an existing fixed-input local proof scenario; this chat cannot generate arbitrary new private proofs.'
  },
  bounty: {
    path:'#evidence', label:'Inspect bounty evidence',
    answer:'The pitch deck documents three separate mathematical bounty mechanisms challenging best execution, portfolio optimality and clearing maximality, with a historical total of 3,000 valueless test tUSD unclaimed. The on-chain bounty logic checks a challenger’s actual submitted counterexample; an invalid proof does not earn a payout. This chat cannot submit a bounty challenge or promise public bounty funds. Inspect the Evidence page and original reproducibility scripts.'
  },
  evidence: {
    path:'#evidence', label:'Open verification evidence',
    answer:'The QED evidence archive distinguishes historical Ethereum Sepolia receipts, verified contracts, documented reverts and reproducibility instructions from transactions in your disposable local Anvil sandbox. The pitch deck reports 196 public testnet transactions and 24 verified contracts at submission time; these are historical figures, not live session totals. Use Evidence to inspect hashes and supporting documentation.'
  },
  routing: {
    path:'#execution', label:'Inspect route and proof',
    answer:'For conversions, the optimizer may split input across the owner-approved constant-product pools and use intermediate token hops. It supplies a vector of dual prices so QEDExecution computes an upper bound over ALL allowed venues at execution state. The realized output must meet the independent co-signer’s floor AND be within the 1 ppm certificate tolerance. This is not a guarantee over all of DeFi. Execution shows actual routes, balances and proofs after a real local trade.'
  },
  limitations: {
    path:'#evidence', label:'Inspect known limitations',
    answer:'QED is an unaudited prototype using valueless test tokens. The best-execution proof covers only honest owner-approved constant-product pools and the state in which the trade executes; it does not prevent every smaller-than-floor front-run. The standing policy enforces safety, not that a slow or idle agent will act. Concentrated liquidity is outside the stated proof. These limitations are documented in the original evidence.'
  }
});

const ROUTES = [
  ['privacy',/(zero.?knowledge|groth|zk.?proof|private (?:data|portfolio)|confidential)/i],
  ['clearing',/(debt.?clearing|multi.?lateral|netting|gridlock|maximal clearing)/i],
  ['escrow',/(escrow|paid work|pay.?for.?work|client.*refund|signed quote)/i],
  ['portfolio',/(portfolio|kkt|covariance|minimum variance|markowitz|stationarity|complementary slackness)/i],
  ['bounty',/(bount(?:y|ies)|refut|challenge.*theorem)/i],
  ['evidence',/(sepolia|historical|196 transaction|24 (?:verified )?contracts|reproduc|public.*evidence|transaction e1)/i],
  ['limitations',/((?:limit(?:ation|ations) of qed|qed.{0,12}limitations?)|what (?:doesn.t|cannot) qed|concentrated liquidity|(?:co?w|uniswapx|1inch) protocol|front.?run|audited)/i],
  ['security',/(48 attacks?|both.*keys|keys.*stolen|blast.radius|honeypot|adversar|ring.?fenc|liabilit|creditor|attacker|security)/i],
  ['routing',/(route|routing|five venues|split.*trade|liquidit(?:y|ies)|price vector|dual bound|1 ppm)/i],
];

export function identifyKnowledgeTopic(message) {
  return ROUTES.find(([_, re]) => re.test(message))?.[0] ?? null;
}
