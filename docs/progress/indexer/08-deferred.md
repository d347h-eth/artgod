# Deferred Tasks

This document collects intentionally deferred work so it stays visible without blocking current phases.

## Tx Calldata Fetch Strategy (Batching vs Full Block)

Context:

- We need tx calldata for transactions that emitted NFT transfer events to decode paid amounts for fills and other orderbook logic.
- We should only fetch txs that contain relevant events, not all txs in a block.
- Live sync will often use public RPC nodes; backfill may use a private or high-tier archive node.

Options and trade-offs:

1. Per-tx fetch by hash (current behavior)

- Pros:
    - Only fetches the txs we actually need (event-scoped).
    - Keeps payload sizes small and predictable for public nodes.
    - Works with any standard JSON-RPC endpoint.
- Cons:
    - Many HTTP round-trips when a block has many relevant logs.
    - Latency adds up for backfill ranges.

2. JSON-RPC batching for per-tx fetch

- Pros:
    - Preserves the event-scoped model while reducing network round-trips.
    - Supported by viem via `http({ batch: { batchSize, wait } })`.
    - Good default for local nodes and many providers.
- Cons:
    - Some public providers disable batching or limit batch size.
    - Needs careful tuning (small batch size, low wait) to avoid large payloads.

3. Full block fetch with transactions (`getBlock(..., includeTransactions=true)`)

- Pros:
    - One call per block; fewer round-trips for dense backfills.
    - Strong consistency within a block; all tx inputs available in one response.
- Cons:
    - Large payloads; can time out or hit rate limits on public nodes.
    - Fetches many txs we do not need during live sync.
    - Not suitable for public nodes without explicit opt-in.

Recommended approach (deferred):

- Keep event-scoped per-tx fetch for live sync.
- Add optional JSON-RPC batching for per-tx fetch to reduce round trips.
- Add a configurable mode for backfill that can switch to full block tx fetch when a node is known to support it.
- Keep a strict default that avoids full block fetch on public nodes.

Possible config surface (to consider later):

- `RPC_TX_FETCH_MODE=byHash|fullBlock`
- `RPC_BATCH_SIZE` and `RPC_BATCH_WAIT_MS` when `byHash` is used.
- Backfill-only override (for example `RPC_BACKFILL_TX_FETCH_MODE`).

Guardrails:

- If a provider rejects batching, fall back to non-batched requests and log a warning.
- Full block mode should be opt-in and ideally tied to a known, trusted node.
