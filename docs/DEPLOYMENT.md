# QED — Deployment & Operations

## Live deployment (Ethereum Sepolia, chain id 11155111)

23 contracts, all verified on Sourcify with a creation and runtime bytecode match; the full table with explorer links is in [`verification/README.md`](../verification/README.md), every transaction in [`EVIDENCE.md`](EVIDENCE.md).

| Run | Contracts | First block |
|---|---|---|
| 1 · payments, escrow, honeypot | QEDVault (agent) `0x441f…8ca6` · ProofEscrow `0x2e33…ba9f` · MinVarianceVerifier `0x1d3e…dd05` · QEDLens `0x8461…f101` · TestUSD `0x7adb…3f35` (6 dp, `faucet()` 1,000/day) · QEDVault (honeypot, keys published) `0xe5b3…7f04` | 11,948,657 |
| 2 · certified clearing | QEDClearing `0x7b7d…6ad2` · TestUSD (clearing) `0x6753…52d4` | 11,949,578 |
| 3 · zero-knowledge job, bounties | Groth16Verifier `0xc043…4e7b` · PrivateMinVarianceVerifier `0x1270…b453` · OptimalityBounty `0xfc21…b677` · MaximalityBounty `0xd767…7d69` | 11,951,192 |
| 4 · best execution | QEDExecution `0x8e2e…9481` · QEDVault tUSD treasury `0x04d1…d117` · QEDVault euro reserve `0x6fb7…9c53` · tEUR `0x98d1…362f` · tETH `0xf61c…580f` · CPMMPool ×5 (`0xf88d…8a58`, `0x1fd2…6031`, `0x4422…829b`, `0x7067…dbfa`, `0x8155…1c64`) | 11,952,692 |
| 4b · execution bounty | ExecutionBounty `0x3148…19c4` (1,000 tUSD) | 11,952,779 |

Machine-readable: `deployments/11155111.json` (Run 1) and the `contracts` block of each run's `evidence/ethereum-sepolia/**/manifest.json`.

## Prerequisites

* Node 22, npm
* Foundry (`forge`, `anvil`, `cast`) — `curl -L https://foundry.paradigm.xyz | bash && foundryup`
* `git clone --recursive` (OpenZeppelin 5.1 and forge-std are submodules)

```bash
npm ci
forge build            # solc 0.8.26, via-IR, optimizer 200 runs
```

## Local (no keys, no network)

```bash
anvil &                              # or let the script start one
QED_OFFLINE=1 npm run local          # deterministic dev keys, offline brain
```

Evidence lands in `evidence/local/`; build the dashboard against it with `EVIDENCE=evidence/local npm run build:app`.

## Public network

1. `cp .env.example .keys.env` and fill in **fresh** keys (one per role). `.keys.env*` is gitignored.
2. Fund only the deployer; the script funds every other role with exactly the gas it needs.
3. Run:

```bash
RPC_URL=https://ethereum-sepolia-rpc.publicnode.com CHAIN_ID=11155111 \
GAS_LIMIT=16700000 MAX_FEE_GWEI=0.02 PRIORITY_FEE_GWEI=0.01 REQUIRE_FIXED_GAS=1 \
npm run live
```

The orchestrator spawns the co-signer (port 7701), vendor (7702) and agent (7703) as **separate processes, each given exactly one private key**, and records every step into `evidence/<network>/manifest.json`.

### Why a fixed gas limit on Sepolia

Sepolia currently prices state creation far above the classic schedule (a plain transfer to a fresh account ≈ 205 k gas; deploying the 9.1 KB vault ≈ 15 M gas) and EIP-7825 caps any transaction at 2²⁴ = 16 777 216 gas. Local nodes don't model this, so `eth_estimateGas` against a replica under-estimates. Every transaction therefore carries `GAS_LIMIT=16700000`; only gas **used** is charged. `REQUIRE_FIXED_GAS=1` makes every process refuse to send without it.

### Signing without RPC egress (how the canonical evidence was produced)

`SHADOW_OF=11155111 npm run local` runs the same economy against an anvil replica (chain id 11155111, `osaka`, wall-clock timestamps, deployer nonce/balance mirrored from Sepolia), then `agent/scripts/outbox.ts` exports the signed raw transactions in canonical order to `relay/outbox-11155111.json`. Any machine with RPC access can broadcast them unchanged (`eth_sendRawTransaction`) and compare each receipt with the replica's (`shadowStatus`, `shadowLogs`). `npm run resume` rebuilds the replica by replaying the exact bytes already on-chain and continues the scenario.

## Operations runbook

| Situation | Action | Who |
|---|---|---|
| Suspected agent or co-signer compromise | `pause()` | guardian or owner |
| Invalidate every outstanding mandate and certificate | `bumpEpoch()` | owner |
| Revoke one mandate | `revokeMandate(hash)` | owner |
| Rotate keys | `setAgent` / `setCosigner` / `setGuardian` | owner |
| Change the global 24 h cap | `setDailyCap` | owner |
| Resume | `unpause()` | owner only |
| A creditor's bill is due | `settle(id)` | anyone — works while paused |
| Change the venues the agent may trade on | `QEDExecution.setVenues(pools, fees)`: each declared fee is cross-checked against the pool's own `feeBps()`; the new venue-set hash invalidates every outstanding signed order | vault owner |
| Rotate the trading hot key | `QEDExecution.setOperator(addr)` | vault owner |
| Withdraw the agent's trading authority entirely | `QEDVault.setAgent(other)` — QEDExecution then cannot move funds at all | vault owner |
| Stop a standing treasury policy | let it expire (`validUntil`), have the co-signer drop its nonce, rotate the operator, or `pause()` the vault | owner / co-signer operator |

Monitor: `QEDExecution.quoteBound(amountIn, tokenIn, tokenOut, prices)` is a free view that returns the bound any route would be measured against, so a monitor can price every pending order before it lands; `BestExecution` events record input, spent, output and bound for every accepted trade. `QEDLens.snapshot(vault)` returns balance, ring-fenced, free, 24 h blast radius, open liabilities, epoch and paused state in one call; the dashboard polls it live.
