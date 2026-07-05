# Deferred Tasks

This document collects intentionally deferred work so it stays visible without blocking current phases.

## Zero-Log Retry (Targeted Indexer)

Context:

- The blueprint assumes full-range indexing: if a block has transactions but returns zero logs, it may be an eventual-consistency issue worth retrying.
- ArtGod currently indexes only specific contracts (address-filtered `getLogs`), so most blocks will naturally have zero relevant logs.

Why deferred:

- The naive rule would re-fetch almost every block with transactions, creating noise and unnecessary load.
- We currently lack a cheap, reliable predicate to say a block _should_ have emitted relevant logs.

Possible future predicates:

- A prefilter that inspects tx `to` for tracked contracts (requires extra tx fetches).
- A side-channel signal that a tracked contract was touched (e.g., a mempool or on-chain hint).
- Full-range indexing mode (no address filter) where the original blueprint rule applies.

Decision:

- Defer until we add a reliable predicate or switch modes. Keep the pipeline simple and event-driven for now.

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

## Blur Fills Without Traces

Context:

- The reference indexer relies on transaction traces to locate Blur executions and map maker/taker.
- ArtGod targets public JSON-RPC nodes with no `debug/trace` support, so we must decode fills from calldata alone.
- Blur v2 uses explicit `takeBid*` / `takeAsk*` selectors and calldata includes the full order payload, so decoding is possible when the tx calls the exchange directly.

Why deferred:

- Many Blur fills are routed through aggregators or delegatecalls where the exchange is not the direct `to` address.
- Without traces, we cannot reliably walk internal calls or resolve delegatecall contexts.
- Heuristic parsing of calldata blobs is possible but brittle, especially across router upgrades.

What could be done later (heuristic-only path):

- Detect direct exchange calls by matching tx `to` against Blur exchange addresses.
- Decode calldata by selector for:
    - v2: `takeAsk`, `takeAskSingle`, `takeAskPool`, `takeAskSinglePool`, `takeBid`, `takeBidSingle`
    - v1: `execute` / `_execute` (if still used in direct calls)
- If the tx calls a known router, attempt router-specific ABI decode to extract the embedded exchange call.
- Maintain a list of supported router addresses/selectors; log and skip unknown router flows.

Impact if deferred:

- We will decode Seaport/OpenSea fills first (main priority).
- Blur fills will be missing unless they are simple direct calls and we add the selector-based decode later.

Decision:

- Defer Blur fill decoding until Seaport is stable and we have a clear, maintainable heuristic strategy for router calls without traces.

## Backfill Write Buffer

Context:

- The reference indexer serializes ownership writes during backfill to avoid DB deadlocks.
- ArtGod plans to bootstrap collections with an ownership snapshot + short backfill, so full historical backfills are not expected for normal use.

Why deferred:

- A write buffer would add a new queue + worker and would still not make partial backfills "correct" while they are running.
- Our correctness story is anchored on the snapshot block; a write buffer is more about throughput than correctness.

Decision:

- Defer the write buffer until full historical backfills become common or we see real contention.
- If reintroduced, it should be paired with explicit API gating to signal "ownership state in progress" during long backfills.

## Bootstrap Backfill Check Improvements

Context:

- Bootstrap completion currently polls every few seconds by counting `blocks` in the short backfill range.
- This is simple but can create unnecessary queue churn and doesn’t react immediately to progress.

Possible improvements (deferred):

1. **Progress‑driven completion**
    - Sync worker emits a `bootstrap.collection.backfill-progress` job per batch.
    - Bootstrap worker tracks highest completed block and marks `live` once it reaches target.

2. **Persisted progress cursor**
    - Sync worker updates `bootstrap_last_synced_block` as batches finish.
    - Bootstrap worker only checks this cursor instead of scanning `blocks`.

3. **Adaptive polling**
    - Use exponential backoff (e.g. 2s → 5s → 10s → 30s).
    - Reduces polling load during long backfills.

Decision:

- Keep simple 5s polling for now, revisit when bootstrap throughput or queue load warrants.

## Bootstrap Without ERC721Enumerable (User-Provided Inputs)

Context:

- Bootstrap snapshots currently rely on ERC721Enumerable (`totalSupply` + `tokenByIndex`) to enumerate token IDs.
- Many collections omit ERC721Enumerable, so `tokenByIndex` is not available.
- `totalSupply` alone does not provide token IDs because ERC‑721 IDs are not guaranteed to be contiguous or start at 0/1.

Problem:

- Without a reliable on-chain enumeration method, we cannot build a correct ownership snapshot without extra inputs.

Possible strategies (deferred, user-assisted):

1. **User-provided explicit ID list**
    - User supplies the exact token IDs to snapshot.
    - Most accurate, but requires manual preparation.

2. **User-provided contiguous range + heuristic `ownerOf`**
    - User supplies `minId` + `maxId` (or `startId` + `totalSupply`).
    - Snapshot calls `ownerOf` across the range and skips reverts.
    - Works only if the collection is known to mint in a contiguous, stable range.
    - Risk of missed tokens if IDs are sparse or non-standard.

3. **Full/partial historical event scan**
    - Build the token ID set by scanning `Transfer` events up to an anchor block.
    - Requires more RPC work and approximates a historical indexer path.
    - Conflicts with the “no full backfill” bootstrap goal unless strictly bounded.

Recommended approach (future):

- Keep current default: **require ERC721Enumerable** for automated bootstrap.
- If missing, require user-provided token ID list or explicit range, with warnings.
- Consider adding a “manual bootstrap mode” to accept these inputs and mark the collection as “user-verified.”

Impact if deferred:

- Collections without ERC721Enumerable cannot be auto-bootstrapped yet.
- This is acceptable while we prioritize ERC‑721 collections that support enumeration.

## Collection Media Mapping and Cache Policy

Context:

- Bootstrap contract probing can fetch and validate a sample `tokenURI` JSON payload.
- Current metadata ingestion normalizes known media fields such as `image` and `animation_url`.
- Raw token metadata JSON is a bootstrap-time inspection aid only; runtime media routing must not depend on `token_metadata.raw_json`, because raw payload persistence is disabled by default.
- Current image-cache behavior is collection-level and assumes one effective token-card media source, with resized cache output reused for every frontend media purpose.

Desired future behavior:

- Let advanced users inspect the probed sample metadata payload in a collapsed bootstrap section that expands into inert, pretty-printed plaintext.
- Detect media-pointer fields from that payload using the existing media URI normalization path.
- Let users map each detected media field to:
    - persistence plan: none, resized cache, original passthrough, or both resized and original where supported
    - frontend purpose: token card preview, fullscreen preview, token detail, or none
- Preserve the current happy path as the default policy: use the effective image source for resized token-card cache and present it consistently across frontend purposes unless the user changes the mapping.

Design notes:

- Persist the selected mapping as a collection media policy during bootstrap. Do not carry the raw metadata payload past bootstrap except as optional debug storage.
- Model cache entries by token, source field, cache variant, and purpose instead of assuming one cached image per token.
- Metadata refresh should recompute only the configured media sources and cache variants.
- Read models should expose resolved media by frontend purpose so token browser components do not branch on raw metadata keys.
- The frontend should consume purpose-level media fields; it should not inspect arbitrary token metadata JSON during normal browsing.
- Collection-extension media behavior can be a reference point, but the generic policy should not import extension-specific literals or route through extension hooks by default.

Decision:

- Defer until the media cache schema, bootstrap policy contract, metadata refresh behavior, and token browser read model can be designed together.
- Do not add ad-hoc per-field cache switches to the current bootstrap form before that contract exists.
