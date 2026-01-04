# Job Queueing & Asynchronous Workflows

## Queueing Strategy

The system relies heavily on asynchronous processing to decouple sync (latency-sensitive) from heavy computation (metadata, analytics).

*   **Infrastructure:** Distributed Task Queue (e.g., RabbitMQ with Delayed Message Plugin).
*   **Patterns:**
    *   **Delayed Jobs:** "Retry this in 30 seconds."
    *   **Deduplication:** "Don't queue `RefreshMetadata(Token X)` if it's already pending." (Implemented via Redis locks using `jobId`).
    *   **Batched Consumption:** Workers pull N jobs at once for throughput.

## Core Job Categories

### 1. Sync & Reorg
*   **`events-sync-realtime`**: Main sync loop.
    *   *Outcome:* Persisted Events, `OnChainData`.
*   **`events-sync-backfill`**: Historical sync loop.
*   **`block-check`**: Delayed check for reorgs.
    *   *Logic:* `if (db.block.hash != rpc.block.hash) -> unsyncEvents(block)`.

### 2. Orderbook Maintenance
*   **`order-updates-by-maker`**: Triggered by Transfers/Approvals.
    *   *Action:* Re-validate all orders for Maker + Token.
*   **`order-updates-by-id`**: Triggered by specific events (Cancel, Fill).
    *   *Action:* Update status of specific order.
*   **`orderbook-orders-queue`**: Ingest new on-chain orders (e.g. from Seaport `OrderFulfilled` or specialized `Order` events).
*   **`opensea-listings-queue`**: Ingest off-chain orders from OpenSea Stream.

### 3. Inventory & Metadata
*   **`token-updates-mint-queue`**: Triggered by mint events.
    *   *Action:* Mark token as valid, fetch initial metadata.
*   **`metadata-index-fetch`**: Fetch metadata from URI.
    *   *Action:* Http Get -> Parse JSON -> Normalize Attributes -> `metadata-index-write`.
*   **`collection-updates-recalc-owner-count`**:
    *   *Action:* `SELECT count(distinct owner) FROM nft_balances WHERE contract = X`.

### 4. Elasticsearch / Analytics (Optional)
*   **`process-activity-event`**: Triggered by Transfer/Fill.
    *   *Action:* Format document -> Bulk Index to Elasticsearch.

## Message Processing Outcomes

| Queue | Input | Processing Logic | Outcome |
| :--- | :--- | :--- | :--- |
| `events-sync-realtime` | Block N | Fetch & Parse & Write | DB Rows + Trigger `order-updates` |
| `order-updates-by-maker` | Maker, Contract | Query Orders -> Validate (RPC) | Update `orders.status` |
| `metadata-fetch` | Token URI | Fetch HTTP | Queue `metadata-write` |
| `opensea-listings` | JSON Payload | Validate Sig & Params | Insert `orders` + Trigger `order-updates` |

## Failure Handling

1.  **Retry Policy:** Exponential backoff (e.g., 5s, 30s, 5m).
2.  **Dead Letter Queue (DLQ):** After Max Retries (e.g., 5), move to DLQ.
3.  **Isolation:** A failure in `metadata-fetch` does *not* stop `events-sync`.
