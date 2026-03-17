# Indexer Short-Term Roadmap (Top 5 Gaps)

This roadmap ranks the most important missing capabilities from the blueprint and groups them into near-term phases. It is intentionally minimal and focused on foundational improvements that unlock the next layers.

## Top 5 Gaps (Ranked)

1. Transaction-aware sync core

- Add transaction fetch and log grouping by tx so downstream domain logic can reason about atomic state changes.

2. Transaction persistence + attribution

- Persist calldata for txs that emitted relevant events and enrich tables with block/tx attribution.

3. Collection-scoped OnChainData + domain job scaffolding

- Keep token-scoped onchain signals resolved to `collectionId` before downstream jobs and split broader invalidation signals into explicit global triggers.

4. Reorg rollback completeness

- Ensure rollback removes all derived domain rows (orders, metadata, activities) and keeps domain state consistent after resync.

5. Sync reliability extras

- Add gap detection, zero-log retry, and backfill RPC usage to harden the realtime pipeline.

## Phased Plan (Short-Term)

### Phase 1: Transaction-Aware Sync Core

[x] Fetch tx data in sync worker where needed
[x] Group decoded logs by transaction
[x] Define a minimal EnhancedEvent shape (base params + decoded params)

### Phase 2: Transaction Persistence + Attribution

[x] Persist calldata for txs that emitted relevant events
[x] Add block/tx attribution columns to transfer/balance/order tables
[x] Update rollback to clean up persisted transactions

### Phase 3: OnChainData + Orderbook Scaffolding

[x] Extend OnChainData with collection-scoped fill/order/metadata signals and explicit global triggers
[x] Add order update queues (by maker / by id)
[x] Wire new domain jobs from sync worker (no-op handlers ok)

### Phase 4: Reorg Consistency

[x] Rollback deletes or resets derived domain rows (orders, metadata)
[x] Ensure resync path rehydrates domain state after rollback

### Phase 5: Sync Reliability

[x] Gap check for missing blocks after persistence
[ ] Zero-log retry when txs exist but logs missing
[x] Optional backfill RPC usage for range sync

## Later (Outside Short-Term Scope)

- Offchain order ingestion skeleton (OpenSea/Seaport) with queue plumbing and validation stubs.
