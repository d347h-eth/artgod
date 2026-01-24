# Indexer Short-Term Roadmap (Part 2)

This roadmap picks the next most important gaps after Phase 5. It focuses on getting real orderbook signals and durable pricing data into the system while keeping the pipeline incremental.

## Top 5 Gaps (Ranked)

1) On-chain order event extraction (fills/cancels/orders)
- Implement Seaport/Blur (and similar) log decoding to populate `fillEvents`, `cancelEvents`, and `orderInfos`.

2) Fills persistence + order state updates
- Add a `fills` table and update orders to `filled`/partial fill with price attribution.

3) ERC20 payment + maker trigger coverage
- Track ERC20 transfers and approval changes to invalidate WETH offers (maker triggers beyond NFT transfers).

4) Offchain order ingestion skeleton
- Add an OpenSea stream listener + queue + validation stubs, and persist offchain orders into `orders`.

5) Backfill write buffer for balance updates
- Add a serialized writer queue to avoid `nft_balances` contention during large backfills.

## Phased Plan (Part 2)

### Phase 1: On-Chain Order Extraction
[x] Decode Seaport fills via calldata (no traces) into `fillEvents`.
[ ] Decode Blur fills without traces (heuristic/selector-based; deferred for now).
[x] Add Seaport cancels/orders into `cancelEvents`/`orderInfos` (OrderCancelled/OrderValidated).
[x] Include block/tx attribution for each derived event.

### Phase 2: Fills Persistence and Order Status
[x] Add `fills` table with price/currency attribution.
[x] Update `orders.fillability_status` on fill/cancel events (partial fill later).
[x] Emit activity records for fills using persisted data.

### Phase 3: ERC20 Payment + Maker Triggers
[ ] Track ERC20 transfers related to fills (WETH/USDC) for pricing.
[x] Track WETH approvals and transfers to drive maker re-validation (quiet default).
[x] Extend maker triggers beyond NFT transfers.

### Phase 4: Offchain Orders (Skeleton)
[ ] Add OpenSea stream listener and raw payload queue.
[ ] Validate and normalize payloads into `orders` rows.
[ ] Trigger `order-updates-by-id` for immediate re-validation.

### Phase 5: Backfill Write Buffer
[ ] Add a write-buffer queue for `nft_balances` updates during backfill.
[ ] Serialize balance updates to reduce write contention.
