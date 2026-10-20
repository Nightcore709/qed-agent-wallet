# QED — final pitch script (≈ 9:21 at 135 words per minute)

Deck: `presentation/QED-Final-Pitch.pptx` (same text in its speaker notes) · PDF: `presentation/QED-Final-Pitch.pdf`.
Eleven main slides; appendix A1–A15 is for questions. Speak calmly: the timing leaves about 25 s of slack under 10:00.

| # | Slide | Starts | Length | Words |
|---|---|---|---|---|
| 1 | AI is beginning to control money | 0:00 | 48 s | 107 |
| 2 | The problem: a floor is not a proof | 0:48 | 57 s | 128 |
| 3 | The idea: proof-carrying transactions | 1:45 | 51 s | 114 |
| 4 | The breakthrough: one inequality | 2:36 | 56 s | 125 |
| 5 | Real proof: Sepolia transaction E1 | 3:32 | 50 s | 112 |
| 6 | The product, live now | 4:22 | 61 s | 137 |
| 7 | Autonomy: one signed policy | 5:23 | 60 s | 134 |
| 8 | Security under attack | 6:23 | 48 s | 109 |
| 9 | Why it matters, and what is not validated | 7:11 | 54 s | 121 |
| 10 | Why QED is different | 8:05 | 43 s | 97 |
| 11 | Close | 8:48 | 33 s | 75 |

## 1 · AI is beginning to control money  (0:00 – 0:48)

AI agents are starting to hold money. They pay suppliers, top up reserves and convert currencies, often with nobody watching each transaction. So here is our question: when an AI moves money, who makes sure it acted correctly? Today the answer is usually a spending limit and a hope. QED is an AI treasury in which every payment and every trade carries a proof, and the blockchain checks that proof before any money moves. In one line: AI can decide; QED makes it prove. In the next nine minutes: the problem, the idea, the proof on a public chain, and the product you can try right now.

## 2 · The problem: a floor is not a proof  (0:48 – 1:45)

Take a concrete case. An AI treasury holds dollars and has to pay a euro invoice, so it converts. How do you know it got a good price? Today's wallets and intent systems check one thing: did the trade clear a minimum, a slippage floor of, say, one percent. Everything above that floor is the agent's discretion. A compromised or simply careless agent can leak a little on every trade, and every trade still looks fine. On a thousand seeded markets, routes that clear a one percent floor still give up a median of 14 to 32 basis points. Auction systems compare after settlement, when the money has already moved. In traditional finance, brokers owe clients best execution by law. An AI agent owes it to no one.

## 3 · The idea: proof-carrying transactions  (1:45 – 2:36)

Our idea is simple: don't trust the agent's financial decision; make the chain verify its quality. Here is how money moves in QED. The AI proposes: it reads your instruction and plans the trade, but it holds no key that can pay alone. An independent co-signer, a separate process with its own key, re-derives the decision from the chain and signs only what the owner allowed. Then the contract verifies everything: the owner's signed mandate, the caps, the protected liabilities, and a mathematical proof of quality. If any check fails, the transaction reverts and nothing moves. The AI can be wrong, manipulated, even stolen, and the money still only moves with a valid proof.

## 4 · The breakthrough: one inequality  (2:36 – 3:32)

The new part is that quality proof, which we call certified best execution. The owner approves a set of trading venues. For those venues QED can compute an upper bound, B: the most that any route through them could possibly return, given their live reserves. The agent proves its trade with one price per token, a dual certificate in optimisation terms, and the key property is that any prices give a valid upper bound, so a cheating agent cannot fake a flattering one. The contract recomputes B in the same transaction, rounding against the agent, and accepts only if the output is within tau, one part per million, of B. A worse route does not settle; it reverts. The full derivation is in appendix A1.

## 5 · Real proof: Sepolia transaction E1  (3:32 – 4:22)

This is not a simulation. This is transaction E1 on Ethereum Sepolia, a public test network. Twenty test dollars in, 18.086846 test euros out. The chain's own bound, computed in that same transaction from five venues' live reserves, was 18.086849. The gap is 0.17 parts per million. Look at the route: the agent split the trade across venues, including a two-hop path through test ether, because that is what the optimum required. The contract did not care which route the agent chose; it cared that no route could have done meaningfully better. All 196 of our Sepolia transactions, this one included, can be re-verified by anyone with one command and no keys.

## 6 · The product, live now  (4:22 – 5:23)

And you can try it yourself. This is the QED app, live now; the link is on the last slide. You type an instruction, like convert 12.5 dollars to euros for the invoices. The AI interprets it and proposes; it shows you which of the owner's signed limits it checked, and it cannot sign anything. You confirm as the owner. The co-signer re-derives and signs an order, the agent builds the route and the proof, and the contract checks it. On the right you watch every step: the real transaction, the bound, a 0.26 parts-per-million gap, and the balances reconciled. Ask for 80 dollars and it is refused before anything is signed, because the mandate says 25. The app runs the real QED contracts on a sandbox test chain with valueless tokens, so you need no wallet.

## 7 · Autonomy: one signed policy  (5:23 – 6:23)

So far the owner chose the amount. Here the agent decides. The owner signs one standing policy: keep at least 45 euros free in the reserve, convert in tranches of 2 to 25 dollars, and pay at most 150 basis points each time. Each tick the agent takes the smallest of five limits: what covers the shortfall, what the market can absorb within the cost limit, two caps, and the free funds. Over-eager, it first asked for 25; the co-signer recomputed the rule and refused. Then it converted 19.5, limited by market impact. Then 8.8, limited by need. Then it stopped: target met. On Sepolia the policy then became a contract, which refused over-conversion even with both hot keys stolen. In the app you can sign your own target and watch the agent stop.

## 8 · Security under attack  (6:23 – 7:11)

We attacked it ourselves, on the public chain. Three examples. A compromised agent routes through the direct pools only, 33 basis points worse: that would clear a one percent slippage floor, but the bound catches it and the trade reverts with NotBestExecution. With both hot keys stolen, the agent's and the co-signer's, the attacker tries to pay itself: the vault refuses, because the owner never approved that payee. And with both keys stolen again, it tries to convert more than the policy needs: the policy contract refuses. In total: 48 attacks, 48 reverts, zero test dollars to the attacker. Six of them run live in the app's Security Lab.

## 9 · Why it matters, and what is not validated  (7:11 – 8:05)

Who would need this? First, autonomous treasuries: businesses, DAOs and AI services that hold one currency and owe another can delegate conversion, even its timing, without trusting the agent's routing. Second, regulated firms: a per-trade best-execution record that anyone can recompute from public state. Third, agent-to-agent services: a solver or provider can be paid on a proof instead of being monitored afterwards. Our business model is a hypothesis: a verification layer, with a fee per certified trade or a licence for custodians and agent platforms. To be clear about where we are: no users, no revenue, no partners; it is unaudited and runs on testnets. The next steps are an audit, more venue types, and a pilot with a treasury team.

## 10 · Why QED is different  (8:05 – 8:48)

Is this new? Every ingredient is known, and we cite them. Intent systems and aggregators enforce a minimum output. CoW Protocol compares fills after settlement. Some research computes routes on-chain for one pair, or certifies a router off-chain. Angeris and colleagues gave us the duality. What we did not find, after searching, is a system that makes the optimality of the executed route a condition of the trade itself, checked in the same transaction, inside an agent's spending mandate. And the claim is scoped honestly: the guarantee covers the owner's approved constant-product venues, not all of DeFi.

## 11 · Close  (8:48 – 9:21)

Agents will hold the money. The question is whether they must prove they acted correctly before it moves, or whether we find out afterwards. QED makes it a precondition: who may pay, what may never be spent, whether a trade got the best price, each one checked by the chain. AI can decide. QED makes it prove. The live app, the Sepolia proof ledger and all the code are at these three links. Thank you.

## Live demo option (if a screen is available, replaces part of slide 6, about 60 s)

Open https://qed-judges-preview-production.up.railway.app/ → **Agent** → type “Convert 12 tUSD to tEUR” → **Confirm as owner and execute** → point at the timeline on the right as each step turns green → then “Would converting 80 tUSD violate my mandate?” to show the refusal. If the network fails, stay on the screenshot.

## Appendix map

A1 dual certificate (weak/strong duality) · A2 the mechanism and on-chain rounding · A3 every leak a slippage floor allows · A4 Topic F outcomes with hashes · A5 benchmarks · A6 bounties · A7 reproducibility and limits · A8 authority · A9 solvency · A10 KKT portfolio certificate · A11 paid-work lifecycle · A12 attack matrix · A13 bounded loss · A14 certified clearing · A15 Groth16 private optimality.
