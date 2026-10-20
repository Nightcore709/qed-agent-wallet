# QED — Reproducibility

Exact commands to rebuild, test, run, verify and re-derive every number we publish. Each block lists what you
should see. Times are from a 4-core Linux container. Every command here runs in CI on every push
(`.github/workflows/ci.yml`), and the clean-clone runs are logged in [TESTING.md](TESTING.md#clean-clone-reproduction-log).

## 0. Toolchain

| Tool | Version we used | Needed for |
|---|---|---|
| Node.js | 22.x (22.22.0) | everything off-chain |
| Foundry (`forge`, `anvil`, `cast`) | 1.7.1 | contracts, local chains |
| solc | 0.8.26 (fetched by forge; via-IR, optimizer 200, EVM cancun, no CBOR metadata) | bytecode reproduction |
| circom | 2.2 (optional) | only to re-run the zk trusted setup |
| A Sepolia RPC | any public endpoint; archive state for historical checks | `npm run verify`, live runs |

No API key is needed for anything below except `npm run redteam` (Anthropic) and live runs (your own funded keys).

## 1. Build from a clean clone (≈ 2 min)

```bash
git clone --recursive https://github.com/Nightcore709/qed-agent-wallet && cd qed-agent-wallet
npm ci
forge build
```

Expect `Compiler run successful`. Submodules: OpenZeppelin 5.1 and forge-std.

## 2. Tests (≈ 2½ min)

```bash
forge test          # expect: 145 tests passed, 0 failed   (≈ 100 s; invariants ≈ 350 k adversarial calls)
npm run test:ts     # expect: # tests 60  # pass 60        (≈ 35 s; starts its own anvil for TS ≡ Solidity parity)
npm run typecheck   # expect: no output
```

`FOUNDRY_PROFILE=ci forge test` runs the heavier CI profile (5,000 fuzz runs, invariants 1,024 × 128).

## 3. Run every economy on a local chain, no keys (≈ 8 min in total)

```bash
QED_OFFLINE=1 npm run local            # main economy: paid work, conversation, 18 attacks, honeypot, pause
npm run local:clearing                 # five AI businesses in gridlock, 6 attacks, proven netting, settlement
npm run local:private                  # zero-knowledge job (real Groth16 proof), escrow, both theorem bounties
QED_OFFLINE=1 npm run local:execute    # best execution + the autonomous policy loop (below)
```

`QED_OFFLINE=1` uses the deterministic offline parser instead of the language model; the output says so. Evidence
lands in `evidence/local*/`. Each script fails (non-zero exit) if any expected success reverts or any expected
attack succeeds.

**Exercise the autonomous agent.** `local:execute` ends with the standing-policy loop of Run 4c, using
deterministic dev keys. Its last lines must be:

```
  • PA1   An over-eager agent asks to convert 25.00 tUSD at once; the co-signer re-derives 19.535234 and refuses
  • T1    Agent observes 20.699566 tEUR free (short 24.300434) and decides to convert 19.535234 tUSD now — limited by impact
  ✓ PE1   Agent converts 19.535234 tUSD → 16.816098 tEUR; bound 16.816101; reserve free 20.699566 → 37.515664
  • T2    Agent observes 37.515664 tEUR free (short 7.484336) and decides to convert 8.835281 tUSD now — limited by need
  ✓ PE2   Agent converts 8.835281 tUSD → 7.484336 tEUR; bound 7.484339; reserve free 37.515664 → 45.00
  • T3    Agent observes 45.00 tEUR free: target met, nothing to do
```

These are the same figures, to the raw unit, as transactions `PE1` and `PE2` on Sepolia: the engine is
deterministic and the local market is built exactly as the public one. Set `POLICY_IMPACT_BPS=50` and the agent refuses to trade at all (`T1 … waits: the market is too thin: any tranche ≥ 2000000 would pay more than 50 bps`): a policy it cannot honour produces no transaction, not a forced one.

## 4. Benchmarks (≈ 1 min, deterministic)

```bash
npx tsx benchmarks/run.ts
git diff --exit-code benchmarks/results.json    # expect: no diff (CI fails on any drift)
```

Only solver wall-clock time varies between machines; it is printed, not stored.

## 5. Re-verify the public evidence, with no keys (≈ 3 min)

```bash
npm run verify                                   # RPC_URL and ARCHIVE_RPC may be overridden
```

It checks, from a public Sepolia RPC: the bytecode of all 24 contracts against this build; every recorded
receipt's status, sender and events; every reverted attack's custom error by replaying it on archive state;
signatures recovered from calldata; the KKT certificate and the netting certificate re-checked; the Groth16 proof
re-verified with snarkjs; for each accepted conversion (E1, E2, PE1, PE2) the bound recomputed from the pre-trade
reserves, the route replayed and an independent optimum solved; the policy target met; all three bounty pools
intact; Mallory received nothing. Expect `ALL CHECKS PASSED`; the report is written to
`evidence/ethereum-sepolia/verification.json`. In CI each failed check is also an annotation on the run.

## 6. Reproduce the deployed bytecode

```bash
node agent/scripts/sourcify-inputs.mjs           # regenerates verification/<Contract>.json (standard-JSON inputs)
solc --standard-json < verification/QEDExecution.json > out.json   # solc 0.8.26
```

All 24 contracts are verified on Sourcify with creation and runtime match ([verification/README.md](../verification/README.md)).

## 7. Regenerate derived files

```bash
npm run fixtures:execution && forge test --match-contract QEDExecution   # Solidity fixtures from the TS engine
npm run evidence:md                                                      # docs/EVIDENCE.md from the manifests
npm run build:app                                                        # the dashboard (app/ → site/, dist/)
```

`agent/test/execution.test.ts` fails if the committed fixture drifts from the engine's output.

## 8. Your own run on Sepolia

1. `cp .env.example .keys.env` and generate fresh keys (the file shows a one-line generator); `.keys.env*` is gitignored.
2. Fund only the deployer with Sepolia ETH (≈ 0.05 ETH for the main run; the scripts send every other role its gas).
3. Run, with a fixed gas limit (Sepolia reprices state creation; see [DEPLOYMENT.md](DEPLOYMENT.md#why-a-fixed-gas-limit-on-sepolia)):

```bash
RPC_URL=https://ethereum-sepolia-rpc.publicnode.com CHAIN_ID=11155111 GAS_LIMIT=16700000 \
  MAX_FEE_GWEI=0.02 PRIORITY_FEE_GWEI=0.01 REQUIRE_FIXED_GAS=1 npm run live
```

4. `npm run verify` then checks your run from your manifest (it writes to `evidence/ethereum-sepolia/`, so do this in
   your own clone).

Runs 2–4 (`clearing.ts`, `private.ts`, `execute.ts`, `execution-bounty.ts`, `execute-policy.ts`) read the same
environment and key files and build on Run 1's contracts. We executed them through the replica pipeline below, not
directly against a public RPC; pointing them at one should work the same way but is untested by us. The policy loop
itself is exercised with dev keys by `local:execute` (§3).

## 9. How the canonical evidence was produced (replica and relay)

Our build sandbox had no outbound RPC, so each run was executed against a local replica of Sepolia and the signed
bytes were broadcast unchanged:

```bash
# 1. replica: chain id 11155111, wall-clock timestamps, signers' nonces and ETH mirrored from Sepolia
KEYS_FILE=.keys.env.execution EXTRA_KEYS=.keys.env.clearing SCRIPT=agent/scripts/execute-policy.ts \
  SHADOW_OF=11155111 START_STATE='{"<deployer>":{"nonce":18,"wei":"…"},"<mallory>":{"nonce":17,"wei":"…"}}' \
  OUTBOX_SKIP=59 OUTBOX_NAME=outbox-11155111-execution-policy EVIDENCE_DIR=evidence/shadow-execution-policy \
  npx tsx agent/scripts/local.ts
# 2. the replica first replays the earlier runs' signed transactions byte for byte (agent/src/replica.ts) and
#    aborts if any hash or status differs; only the new transactions are exported (OUTBOX_SKIP)
# 3. relay: any machine with RPC access sends relay/outbox-*.json with eth_sendRawTransaction, grouped by sender,
#    and compares each public receipt's status and logs with the replica's → relay/receipts-*.json
# 4. finalize: agent/scripts/finalize-execution*.ts merges public receipts into evidence/ethereum-sepolia/execution/
```

Run 4d (`agent/scripts/execute-policy-chain.ts`) also sets `ANVIL_GENESIS_TS` to a time before Run 4, so the replica
replays Runs 4–4c **at their original block timestamps**: their certificates had expired by then, and a wall-clock
replay would have diverged.

All 196 receipts matched (status and every log, excluding the chain's EIP-7708 system log). Because the hashes are
of the exact signed bytes, anyone can confirm the relay changed nothing: `keccak256(raw)` of each outbox entry is the
transaction hash on Etherscan.
