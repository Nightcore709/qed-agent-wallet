# Relay: the exact signed transactions broadcast to Ethereum Sepolia

Every transaction in the evidence was signed in the build sandbox by its role's own key, against a
wall-clock-synchronised replica of Sepolia, and exported here **as raw signed bytes** together with the
replica's receipt (`shadowStatus`, `shadowLogs`). A browser relay fetched each file from a pinned commit,
sent the bytes unchanged with `eth_sendRawTransaction`, and compared every public receipt with the replica's.
Because the bytes are identical, the transaction hashes in `docs/EVIDENCE.md` are the hashes of these files.

| File | Transactions | Run |
|---|--:|---|
| `outbox-11155111.json` | 50 | Main run, batch 1: deploy, lifecycle, conversation, attacks, honeypot |
| `outbox-11155111-b2.json` | 5 | Main run, batch 2 (after the escrow deadline): refund, pause, settlement while paused (`npm run resume`) |
| `outbox-11155111-full.json` | 55 | Batches 1 and 2 concatenated, for convenience |
| `outbox-11155111-clearing.json` | 44 | Run 2: certified clearing |
| `outbox-11155111-private.json` | 24 | Run 3: zero-knowledge job and theorem bounties |
| `receipts-11155111-*.json` | | Public receipts fetched by the relay (main-run receipts: `evidence/ethereum-sepolia/receipts.json`) |

Anyone with RPC access can re-broadcast or decode these bytes (`viem.parseTransaction`) and check them against the chain.
