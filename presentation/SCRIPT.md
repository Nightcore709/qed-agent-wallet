# QED — 10-minute talk, demo script and video script

The deck is the Slides artifact *QED Pitch Deck*: 15 slides plus 8 backup slides (B1–B8, QED's foundations before the upgrade). Export it to PowerPoint or PDF from its menu; a PDF of the same slides is in this folder (`QED-Pitch-Deck.pdf`). The deck's speaker notes are the text below, word for word.

Paced at 145 words a minute with three seconds per slide change, the talk runs **9:35**, leaving about 0:25 inside the 10-minute limit. Rehearse with a timer; if you run long, drop the last sentence of slides 10 and 12 first.

Before you start: replace `[team]` in slide 1's notes and the placeholders on slides 1 and 15; open the dashboard (<https://nightcore709.github.io/qed-agent-wallet/>) in a second tab at its *Execution* section in case a judge asks to see a transaction.

## 1. The talk, slide by slide

| # | Slide | Starts at | Length |
|---|---|--:|--:|
| 1 | QED | 0:00 | 33 s |
| 2 | An agent that converts money can leak a little on every trade, and nothing checks it. | 0:33 | 40 s |
| 3 | A price vector is a proof. | 1:13 | 45 s |
| 4 | 20 tUSD in, 18.086846 tEUR out. The chain's own bound: 18.086849. | 1:57 | 42 s |
| 5 | The agent routes freely. The contract checks one inequality. | 2:40 | 37 s |
| 6 | Every leak a slippage limit allows, refused on-chain | 3:16 | 44 s |
| 7 | One signed policy. The agent decided when and how much. | 4:00 | 47 s |
| 8 | The AI is never the sole authority over funds. | 4:47 | 37 s |
| 9 | Each outcome is a public transaction you can open. | 5:24 | 31 s |
| 10 | What the proof buys, including where it buys little | 5:55 | 43 s |
| 11 | Beat the bound and the contract pays you 1,000 tUSD. | 6:38 | 37 s |
| 12 | Every ingredient is known. The guarantee is not. | 7:16 | 39 s |
| 13 | Best execution becomes a precondition, not a quarterly report. | 7:55 | 39 s |
| 14 | Don't trust the slides. Re-derive them. | 8:34 | 37 s |
| 15 | Agents will hold the money. Make them prove it. | 9:11 | 25 s |

### 1. QED · 0:00

Good morning, we're [team]. QED is an AI wallet where the AI may be wrong, manipulated or stolen, and the money is still safe, because every movement of money carries a proof Ethereum checks. Today's upgrade: our agent converts money on its own, and the chain proves, in the same transaction, that each trade came within one part per million of the best price any route could give. Otherwise it doesn't happen.

### 2. An agent that converts money can leak a little on every trade, and nothing checks it. · 0:33

An autonomous treasury doesn't only pay; it converts: a euro invoice paid from dollars, a reserve topped up. That's where an agent has the most discretion and the least oversight. Wallets and intents accept any route above a slippage floor. On a thousand random markets, routes that still clear a one-percent floor give up a median 14 to 32 basis points, and a compromised agent keeps that on every trade. Solver auctions check best price afterwards, by governance. Brokers have a legal duty of best execution. Agents have none.

### 3. A price vector is a proof. · 1:13

The key idea: routing through constant-product pools is a convex problem, so it has a dual. Pick any price for each token, and the value of every possible route is bounded by this sum, one closed-form term per pool from its live reserves and fee. Three properties follow. Unforgeable: every price vector gives a valid bound, so an agent can't fake a proof, only fail to have one. Tight: at the right prices the bound equals the optimum, and our solver finds them in milliseconds. Exact: we round every step upward, so it survives the EVM. The contract checks one inequality.

### 4. 20 tUSD in, 18.086846 tEUR out. The chain's own bound: 18.086849. · 1:57

Here it is on the public chain, transaction E1. The owner asked, in plain English, to move 20 test dollars into the euro reserve. The agent split it: most through the deep pool, some through the cheap thin pool, a slice through a bridge token and back. The off-market pool went unused, but it's still inside the bound. With the route came three prices. The contract computed the bound from all five venues: 18.086849. What arrived: 18.086846. That's 0.17 parts per million from the best any route could do, checked before the reserve was paid.

### 5. The agent routes freely. The contract checks one inequality. · 2:40

In one transaction the contract checks the order the independent co-signer certified: recipient, the co-signer's own floor, the venue set. It computes the bound over every venue the owner allows, rounding up. Funds come through the original QED vault, so mandate, caps and solvency still apply. The agent's route runs, any shape, and nothing may be left behind. What actually arrived must clear the floor and be within tau of the bound. Whatever route the agent picks, the result is near-optimal.

### 6. Every leak a slippage limit allows, refused on-chain · 3:16

Now we attack it. A compromised agent gets a genuine co-signed order and tries every leak a slippage limit allows. The axis is distance below the bound, log scale. Orange is what a one-percent floor accepts; green is what QED accepts. A direct-pools-only route, 33 basis points short, would pass any one-percent wallet: here it reverts with NotBestExecution. A half-basis-point skim: rejected. Prices chosen to bless a bad route: rejected. Stranding the bridge token, redirecting the output, calling without the key: rejected. A front-run hit the co-signed floor, and our agent then declined to trade into the moved market.

### 7. One signed policy. The agent decided when and how much. · 4:00

So far the owner chose the amount. Here the agent decides. The owner signed one policy: keep 45 euros free in the reserve, tranches of 2 to 25 dollars, at most 150 basis points each. Each tick the agent converts the minimum of five quantities: what covers the shortfall, the most the market takes within the limit, two caps and free funds. Over-eager, it first asked for 25; the co-signer recomputed the rule from the chain and refused. Then 19.5, limited by impact. Then 8.8, limited by need. Then it stopped. Later the policy became a contract that, with both hot keys stolen, still refused over-conversion.

### 8. The AI is never the sole authority over funds. · 4:47

Who can actually move money? On the left, what might be wrong or compromised: the agent, whose language model only reads the owner's words and holds no key, and an independent co-signer with its own key. On the right, what binds: the vault's mandate, caps and solvency, the best-execution check, and now the policy itself as a contract. We stole both hot keys on Sepolia and tried to over-convert, overpay and keep going after the target: the contract refused all of it.

### 9. Each outcome is a public transaction you can open. · 5:24

Topic F's four outcomes, each a transaction. One: a separate agent key under an independent certificate: L4 for a payment, E1 for a trade, PE1 for a trade the agent started itself. Two: paid work settled through escrow, on an optimality proof and on a zero-knowledge proof. Three: 48 attacks, 48 reverts, nothing to the attacker. Four: one command re-derives every claim, with no keys, daily in CI.

### 10. What the proof buys, including where it buys little · 5:55

Does it matter? On a thousand seeded markets, routing policies without a proof fall a median 34 to 117 basis points short of the optimum. The security reading: among routes that still clear a one-percent floor, a hostile agent keeps a median 14 to 32 basis points per trade. Under QED, at most one part per million. Our own routes land a median 0.075 parts per million from their bound. And honestly: for small trades in deep markets a good router is already within about three basis points, so there QED adds the guarantee, not the average.

### 11. Beat the bound and the contract pays you 1,000 tUSD. · 6:38

A claim like this should be falsifiable, so we put money on it. ExecutionBounty holds a thousand test dollars. Give it any route and prices: it runs your route on its own funds, compares with the deployed bound, and pays you if you beat it. No judge. On Sepolia, three attempts, including the whole pool in one trade, reverted with TheoremHolds. Six thousand fuzzed attempts never beat the bound, and a positive control shows the bounty does pay when a bound is wrong.

### 12. Every ingredient is known. The guarantee is not. · 7:16

Is it new? Every ingredient is known, and we cite it. Intents and aggregators enforce a minimum output. CoW checks best price after settlement. Some work computes routes on-chain for one pair, approximately, without a bound. A 2026 paper certifies a router off-chain, then protects execution with slippage. Angeris and colleagues gave us the duality. What we didn't find is a contract that accepts a trade only if its measured output is within a stated tolerance of a bound over all permitted venues, computed in the same transaction.

### 13. Best execution becomes a precondition, not a quarterly report. · 7:55

Who needs this? Any treasury run by an agent: a business, a DAO, an AI service holding one currency and owing another, say a euro invoice paid from dollars across borders. It can delegate the conversion, even its timing, without trusting the routing. Regulated firms get a per-trade best-execution record anyone can recompute. Solvers can be accepted on a proof instead of monitored afterwards. And the research question generalises: which fiduciary duties can become conditions the chain checks before money moves? No users or revenue are claimed.

### 14. Don't trust the slides. Re-derive them. · 8:34

Please don't trust these slides. One command re-derives every claim from a public Sepolia node with no keys: bytecode, receipts, replayed attacks, each bound recomputed, each route replayed. Another runs the whole economy and the autonomous policy on a laptop and reproduces the Sepolia trades to the last unit. The limits, plainly: a front-run smaller than the one-percent floor isn't caught; venues must be honest constant-product pools; the policy contract enforces safety, not liveness; and this is an unaudited testnet prototype.

### 15. Agents will hold the money. Make them prove it. · 9:11

Agents are going to hold real money. QED's answer is to make them prove it: who may pay, what may never be spent, whether work is optimal, and now whether every trade got the best price, all checked before money moves. Everything is on the dashboard and in the repository. Thank you.

## 2. Live demo script (Q&A, or instead of slides 4–7 if a live demo is allowed)

Everything below is public; no wallet or keys are needed. About three minutes.

1. **Dashboard → Execution.** Open <https://nightcore709.github.io/qed-agent-wallet/#execution>. Point at the route graph: “20 tUSD split over four venues and a two-hop path; the labels are the three prices the agent sent as its proof.”
2. **Open E1 on Etherscan** (click `E1` in the ledger, or <https://sepolia.etherscan.io/tx/0x56f798cd321e0d85ba6a7b1425dd7b12f04db386a81bf0e67c94374f12f19690>). Logs tab → `BestExecution`: `amountOut 18086846`, `bound 18086849`. “The contract computed that bound itself, from the reserves of all five pools, in this transaction.”
3. **Back to the accept-zone strip** (“One co-signed order, four routes”). “A 1% floor accepts all four. QED accepts one.” Open `EA1` (<https://sepolia.etherscan.io/tx/0xccd07d1790d002a173435e216c80f0c305e3a10dd0c720548b38d50cd9b54937>): status *Fail*, error `NotBestExecution(17554100, 17612723)`.
4. **Lifecycle lanes.** Read the third lane, *The agent decides*: policy signed, over-reach refused, tranche 1 limited by impact, tranche 2 limited by need, target met.
5. **Optional terminal** (pre-run it; it takes about two minutes): `QED_OFFLINE=1 npm run local:execute | tail -12` shows `PE1 … 16.816098 tEUR` and `PE2 … 7.484336 tEUR`, the same numbers as Sepolia, from dev keys on a laptop.
6. **Optional:** `npm run verify` and scroll to “QED Execute: best execution re-proved independently from public state”.

Fallbacks: if the dashboard's live RPC is slow it shows the committed snapshot and says so; the Etherscan links work regardless. Never claim a number you cannot show on one of these pages.

## 3. Video script (≤ 5 minutes; record the screen and read the narration)

| Time | Screen | Narration |
|---|---|---|
| 0:00–0:25 | Dashboard hero | “This is QED, an AI wallet where the AI can be wrong, manipulated or even stolen, and the money is still safe, because every movement of money carries a proof that Ethereum checks. This video shows our upgrade: proof of best execution for every trade the agent makes.” |
| 0:25–1:05 | Slide 2, then slide 3 | “When an agent converts money, wallets accept any route above a slippage floor, often one percent. On a thousand random markets, a hostile agent can keep a median 14 to 32 basis points per trade without breaking that floor. QED closes the gap with one idea: a price vector is a proof. For any prices, no route through the owner's pools can return more than a bound the chain computes from live reserves.” |
| 1:05–1:50 | Dashboard → Execution: route graph, then E1 on Etherscan (Logs) | “Here the agent converted 20 test dollars to euros through four pools and a two-hop path. It sent three prices with the route. The contract computed the bound, 18.086849, and measured what arrived, 18.086846: 0.17 parts per million from the best possible route. Only then did it pay the reserve.” |
| 1:50–2:35 | Accept-zone strip; EA1 on Etherscan | “Now a compromised agent with a genuine co-signed order. A route over the direct pools only is 33 basis points short; any one-percent wallet accepts it. QED reverts it: NotBestExecution. So does a half-basis-point skim, a fake price proof, a stranded token, a redirected output and a front-run.” |
| 2:35–3:25 | Lifecycle lane “The agent decides”; slide 7 | “Then the agent decides for itself. The owner signed one policy: keep 45 euros free in the reserve, at most 150 basis points per tranche. The agent sized each trade itself: first by market impact, then by remaining need, and stopped when the target was met. And the policy is a contract too: with both hot keys stolen, an over-sized tranche was refused on-chain. Every trade was proved best.” |
| 3:25–4:05 | Slide 8, then slide 11 | “The AI is never the sole authority: the language model holds no key, an independent co-signer re-derives every decision, and the vault and execution contracts have the last word. And we put money on the theorem: a thousand test dollars to anyone whose route beats the bound. Nobody has.” |
| 4:05–4:40 | Terminal: `npm run verify` scrolling; slide 14 | “Don't trust us: one command re-derives every claim from a public Sepolia node, without keys, and another reproduces the agent's trades on a laptop to the last unit. 196 transactions, 24 verified contracts, 48 refused attacks.” |
| 4:40–4:55 | Slide 15 | “Agents will hold the money. QED makes them prove it.” |
