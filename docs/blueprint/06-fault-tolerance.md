# Fault Tolerance, Resilience & Scalability

## 1. Reorg Handling (Chain Reorganization)

Blockchains are eventually consistent. The indexer must handle chain re-writes.

### Detection
*   **Mechanism:** `BlockCheckJob` runs periodically (e.g., 1 min, 5 min) for recent blocks.
*   **Logic:**
    *   Fetch Block N from DB.
    *   Fetch Block N from RPC (Upstream).
    *   If `db.hash != rpc.hash`: **Orphan Detected**.

### Recovery (`Unsync`)
1.  **Identify:** Find the common ancestor (fork point).
2.  **Rollback:** For every block > Fork Point:
    *   Delete `orders` created in this block.
    *   Revert `nft_balances` changes (apply inverse deltas).
    *   Delete `nft_transfer_events`.
    *   Delete `activities`.
    *   *Implementation:* Uses `removeEvents` methods in storage adapter which executes `DELETE` or inverse `UPDATE` queries.
3.  **Re-Sync:** Schedule `events-sync-realtime` for the new canonical blocks.

## 2. Deadlock Avoidance (Write Buffers)

High-concurrency writes to `nft_balances` (hot rows) cause Postgres deadlocks.

### Solution: Write Buffers
*   **Context:** Used primarily during **Backfill**.
*   **Mechanism:**
    1.  `SyncWorker` does *not* write to `nft_balances`.
    2.  Instead, it pushes a `BalanceUpdatePayload` to `nft-transfers-write-queue`.
    3.  **Single-Threaded Consumer:** A dedicated worker consumes this queue.
    4.  **Batching:** It groups updates by token/user and executes bulk `UPSERT` statements.
    5.  **Result:** Serialized writes eliminate deadlocks at the cost of slight latency.

## 3. Scalability Patterns

### Stateless Workers
*   All logic is encapsulated in `Jobs`.
*   Workers connect to RabbitMQ and Postgres.
*   **Scaling:** Auto-scale worker containers based on Queue Depth (CPU/Memory usage is secondary).

### Redis Caching
*   **RPC Cache:** Block headers and Transaction Receipts are cached. Multi-step jobs share this cache to prevent RPC thrashing.
*   **Locks:** `acquireLock(key, ttl)` ensures only one worker processes a specific "Token Refresh" or "Collection Stats Recalc" at a time.

### Database Sharding (Future Proofing)
*   The `OnChainData` structure includes `shards`.
*   Tables can be partitioned by `contract_address` or `block_time`.

## 4. Resilience Gates

*   **Circuit Breakers:** If RPC errors spike, pause the `SyncQueue` consumers.
*   **Rate Limiting:** Adhere to RPC limits using a `RateLimiter` adapter in the `RpcProvider`.
*   **Gap Filling:** `BlockGapCheck` ensures that if the realtime listener misses a Websocket message, the poller catches the missing block sequence.
