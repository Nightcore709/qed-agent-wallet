# QED — final pitch script

Presenters: Apurv Chauhan and Lakshya Goswami, St. Xavier's College, Mumbai. Swap the name in the first line if Lakshya opens.
Deck: `presentation/QED-Final-Pitch.pptx` (this text is in its speaker notes) · PDF: `presentation/QED-Final-Pitch.pdf`.

Twelve main slides, 1061 words: about **9:26** at a calm 120 words per minute including slide changes, leaving room for a 60-second live demo inside 10 minutes. Appendix A1–A17 is for questions.

| # | Slide | Starts | Length | Words |
|---|---|---|---|---|
| 1 | Opening: who makes sure AI acts correctly? | 0:00 | 47 s | 88 |
| 2 | The problem: following the rules is not enough | 0:47 | 61 s | 117 |
| 3 | The idea: proof-carrying transactions | 1:48 | 56 s | 106 |
| 4 | The breakthrough: one inequality | 2:44 | 52 s | 98 |
| 5 | Real proof: Sepolia transaction E1 | 3:36 | 47 s | 88 |
| 6 | The product, live now | 4:23 | 58 s | 110 |
| 7 | Autonomy: the agent decides, then stops | 5:21 | 53 s | 100 |
| 8 | Security under attack | 6:14 | 47 s | 88 |
| 9 | Why it matters and the business hypothesis | 7:01 | 44 s | 82 |
| 10 | Why QED is different | 7:45 | 40 s | 74 |
| 11 | Team and what we need next | 8:25 | 32 s | 58 |
| 12 | Close | 8:57 | 29 s | 52 |

## 1 · Opening: who makes sure AI acts correctly?  (0:00 – 0:47)

Good morning. I'm Apurv, and with Lakshya from St. Xavier's College, Mumbai, we built QED. AI agents are starting to hold money: they pay suppliers, top up reserves and convert currencies, often with nobody watching each transaction. So our question is simple: when an AI moves money, who makes sure it acted correctly? QED is an AI treasury in which every payment and every trade carries a proof, and the blockchain checks that proof before any money moves. In one line: AI can decide. QED makes it prove.

## 2 · The problem: following the rules is not enough  (0:47 – 1:48)

Here is the problem. An AI treasury holds dollars and has to pay a euro invoice, so it converts. Did it get a good price? Today, nothing checks. First, a minimum is not the best: wallets only enforce a slippage floor, so a route 33 basis points worse than the best still passes a one percent floor. Across a thousand test markets, routes that clear the floor still give up a median of 14 to 32 basis points. Second, quality is checked too late, after the money has moved. Third, the agent decides when and how much, and nobody re-checks it. Brokers owe their clients best execution by law. An AI agent owes it to no one.

## 3 · The idea: proof-carrying transactions  (1:48 – 2:44)

Our idea: don't trust the agent's decision; make the chain verify its quality. In QED, the AI proposes: it reads the instruction and plans the trade, but it holds no key that can pay alone. An independent co-signer, a separate process with its own key, re-derives the decision from the chain and signs only what the owner allowed. Then the smart contract verifies everything: the owner's signed limits, the protected funds, and a mathematical proof of quality. If any check fails, the transaction reverts and nothing moves. So the AI can be wrong, manipulated, even stolen, and the money still only moves with a valid proof.

## 4 · The breakthrough: one inequality  (2:44 – 3:36)

The new part is that quality proof: certified best execution. The owner approves a set of trading venues. From their live reserves, QED computes B, the most that any route through them could possibly return. The agent proves its trade with one price per token, and here is the key: any prices give a valid upper bound, so a cheating agent cannot fake a flattering one. The contract recomputes B inside the trade, rounding against the agent, and accepts only if the output is within one part per million of B. A worse route doesn't settle. It reverts.

## 5 · Real proof: Sepolia transaction E1  (3:36 – 4:23)

And this is not a simulation. This is transaction E1 on Ethereum Sepolia, a public test network. Twenty test dollars in, 18.086846 test euros out. The chain's own bound, computed in that same transaction: 18.086849. A gap of 0.17 parts per million. The agent split the trade across venues, including a two-hop path, because that is what the optimum needed; the contract only cared that no route could have done meaningfully better. All 196 of our transactions can be re-verified by anyone with one command and no keys.

## 6 · The product, live now  (4:23 – 5:21)

You can try it yourself; the link is on the last slide. This is the QED app. You type an instruction, like convert 12.5 dollars to euros for the invoices. The AI interprets it and proposes, and shows which of the owner's limits it checked; it cannot sign. You confirm as the owner. The co-signer re-derives and signs, the contract checks the proof, and on the right you watch every step: the real transaction, the bound, and the balances reconciled. Ask for 80 dollars and it's refused before anything is signed, because the limit is 25. It runs the real contracts on a test chain, so you need no wallet.

## 7 · Autonomy: the agent decides, then stops  (5:21 – 6:14)

So far the owner chose the amount. Here the agent decides. The owner signs one policy: keep at least 45 euros free in the reserve, in tranches of 2 to 25 dollars, at no more than 150 basis points of cost. On tick one the reserve is 24 euros short; the agent converts 19.5 dollars, limited by what the market can absorb. On tick two it converts 8.8, exactly what is still needed. On tick three the target is met, and it stops. On Sepolia the policy then became a contract that refused over-conversion even with both hot keys stolen.

## 8 · Security under attack  (6:14 – 7:01)

We attacked it ourselves, on the public chain. Three examples. A compromised agent takes a route 33 basis points worse: it clears a slippage floor, but the bound catches it and it reverts. With both hot keys stolen, the attacker tries to pay itself: the vault refuses, because the owner never approved that payee. And it tries to convert more than the policy needs: the policy contract refuses. In total: 48 attacks, 48 reverts, zero test dollars to the attacker. Six of them run live in the app.

## 9 · Why it matters and the business hypothesis  (7:01 – 7:45)

Who needs this? Autonomous treasuries: businesses, DAOs and AI services that can delegate conversions without trusting the agent's routing. Regulated firms: a best-execution record anyone can recompute. And agent-to-agent services, where a provider is paid on a proof instead of being monitored afterwards. Our business model is a hypothesis: a verification layer, charged per certified trade or licensed to custodians and agent platforms. To be clear: we have no users or revenue yet, it is unaudited, and it runs on test networks.

## 10 · Why QED is different  (7:45 – 8:25)

Is it new? Every ingredient is known, and we cite them. Aggregators enforce a minimum output; CoW Protocol checks fills after settlement; research certifies routers off-chain. What we did not find is a system that makes the optimality of the executed route a condition of the trade itself, checked in the same transaction, inside an agent's spending limits. And we scope it honestly: the guarantee covers the owner's approved venues, not all of DeFi.

## 11 · Team and what we need next  (8:25 – 8:57)

We are two students from St. Xavier's College, Mumbai, and everything you have seen is built and public: 24 verified contracts, 196 real transactions, and 205 tests passing. What we are looking for next: a treasury team or agent platform to pilot with, an independent security audit, and partners to extend the proof to more kinds of venues.

## 12 · Close  (8:57 – 9:26)

Agents will hold the money. The only question is whether they must prove they acted correctly before it moves, or we find out afterwards. QED makes it a precondition. AI can decide. QED makes it prove. The live app, the proof ledger and the code are at these three links. Thank you.

## Optional live demo (60 s, on slide 6)

Open https://qed-judges-preview-production.up.railway.app/ → **Agent** → type “Convert 12 tUSD to tEUR” → **Confirm as owner and execute** → point at the timeline as each step turns green → then “Would converting 80 tUSD violate my mandate?” to show the refusal. If the network fails, stay on the screenshot.

## Appendix map

A1 dual certificate (weak and strong duality) · A2 mechanism and on-chain rounding · A3 every leak a slippage floor allows · A4 Topic F outcomes with hashes · A5 benchmarks · A6 bounties · A7 reproducibility and limits · A8 authority · A9 solvency · A10 KKT portfolio certificate · A11 paid-work lifecycle · A12 attack matrix · A13 bounded loss · A14 certified clearing · A15 Groth16 private optimality · A16 autonomy in detail · A17 problem in detail.
