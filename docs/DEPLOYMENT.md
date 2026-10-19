# QED — Deployment & Operations

## Live deployment (Ethereum Sepolia, chain id 11155111)

| Contract | Address |
|---|---|
| QEDVault (agent) | `0x441f71f12a1f8a3b7d432851d4d4244fc33e8ca6` |
| ProofEscrow | `0x2e3362d6dc88c40cf95f885c44fe8fff9979ba9f` |
| MinVarianceVerifier | `0x1d3eced4bd1cef7edc315315b9fd6acae283dd05` |
| QEDLens | `0x846186f21227793760429696bb4fd7490236f101` |
| TestUSD (tUSD, 6 dp, `faucet()` 1 000/day) | `0x7adb609421e30b3df3063ff2de9d425564893f35` |
| QEDVault (honeypot, keys published) | `0xe5b3e7773115dba454e7e40fa97a5d3e332c7f04` |

Deployment block 11 948 657. Machine-readable: `deployments/11155111.json`. All transactions: `docs/EVIDENCE.md`.

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

Monitor: `QEDLens.snapshot(vault)` returns balance, ring-fenced, free, 24 h blast radius, open liabilities, epoch and paused state in one call; the dashboard polls it live.
