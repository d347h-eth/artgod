# Indexer Short-Term Roadmap (Part 3)

This roadmap follows Part 2 and reflects the ArtGod approach: **bootstrap collections via an ownership snapshot + short backfill** (no runtime ownership fallback).

## Guiding Constraints

- `nft_balances` is the only canonical ownership state after bootstrap.
- No fallback ownership table is used at runtime.
- A collection is “ready” only after snapshot + short backfill complete with no gaps.
- Reorg safety: snapshot block must be chosen with confirmation depth in mind.

## Phase 1: Collection Bootstrap Foundation

[x] Add collection bootstrap state model (initial `bootstrapping | live | paused | disabled`).
[x] Persist per-collection bootstrap metadata (anchor block, started/finished timestamps, last synced block).
[x] Add bootstrap job queue + worker runtime to orchestrate steps.
[x] Gate live sync per collection until bootstrap is complete.

## Phase 2: Ownership Snapshot Pipeline

[x] Snapshot job for ERC-721: enumerate token IDs, call `ownerOf(tokenId)` at anchor block.
[x] Explicitly scope bootstrap to **ERC-721 only** (ERC-1155/ ERC-20 deferred).
[x] Persist snapshot rows into a temporary snapshot table.
[x] Finalize snapshot into `nft_balances` (single transaction per collection).
[x] Record the anchor block number for the collection.

## Phase 3: Short Backfill (Anchor → Head)

[x] Backfill range from `anchorBlock + 1` to head at bootstrap start.
[x] Ensure gapless processing before marking collection as live.
[x] On completion, switch the collection to realtime sync.

## Phase 4: Offchain Order Validation (Seaport)

[x] Validate signature + expiry for OpenSea/Seaport orders.
[x] Conduit approval checks (cache or on-demand RPC).
[x] Onchain balance/approval checks to set fillability.

## Phase 5: OpenSea Event Coverage

[x] Normalize collection offers and trait offers.
[x] Handle cancels / invalidations / revalidations.
[x] Map events to order upserts or update-by-id triggers.

## Phase 6: Metadata Enhancements

[x] ERC4906 handling + metadata refresh queue.
[x] Normalize `tokens` + `token_attributes` tables.
[x] Trait aggregation / collection stats recompute.

## Phase 7: Reliability Improvements

[ ] RPC rate limiter + circuit breaker.
[ ] Optional shared cache/locks if multi-worker scaling is enabled.
