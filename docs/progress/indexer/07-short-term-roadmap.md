# Indexer Short-Term Roadmap (Top 5 Gaps)

This roadmap ranks the most important missing capabilities from the blueprint and groups them into near-term phases. It is intentionally minimal and focused on foundational improvements that unlock the next layers.

## Top 5 Gaps (Ranked)

1) Transaction-aware sync core
- Add transaction fetch and log grouping by tx so downstream domain logic can reason about atomic state changes.

2) OnChainData expansion + domain job scaffolding
- Extend OnChainData to include order/fill/cancel signals and maker triggers; add queues and handlers to route them.

3) Reorg rollback completeness
- Ensure rollback removes all derived domain rows (orders, metadata, activities) and keeps domain state consistent after resync.

4) Sync reliability extras
- Add gap detection, zero-log retry, and backfill RPC usage to harden the realtime pipeline.

5) Offchain order ingestion skeleton
- Establish a minimal offchain order ingestion pipeline (OpenSea/Seaport) with queue plumbing and validation stubs.

## Phased Plan (Short-Term)

### Phase 1: Transaction-Aware Sync Core
[ ] Fetch tx data in sync worker where needed
[ ] Group decoded logs by transaction
[ ] Define a minimal EnhancedEvent shape (base params + decoded params)

### Phase 2: OnChainData + Orderbook Scaffolding
[ ] Extend OnChainData with fill/cancel/order/maker triggers (stubs allowed)
[ ] Add order update queues (by maker / by id)
[ ] Wire new domain jobs from sync worker (no-op handlers ok)

### Phase 3: Reorg Consistency
[ ] Rollback deletes or resets derived domain rows (orders, metadata)
[ ] Ensure resync path rehydrates domain state after rollback

### Phase 4: Sync Reliability
[ ] Gap check for missing blocks after persistence
[ ] Zero-log retry when txs exist but logs missing
[ ] Optional backfill RPC usage for range sync

### Phase 5: Offchain Ingestion Skeleton
[ ] Add queue and runtime entrypoint for offchain order intake
[ ] Parse payload to a validated order shape (no persistence requirements yet)
[ ] Hook into order update queues for follow-up validation
