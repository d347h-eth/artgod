# Data Structures & State Capture

## The `OnChainData` Entity

To decouple processing from persistence, the system uses an intermediate Accumulator Pattern. Handlers do not write to the DB directly; they populate an `OnChainData` object.

### Structure

```typescript
interface OnChainData {
  // Inventory
  nftTransferEvents: NftTransferEvent[]; // Log of all transfers
  nftBalances: NftBalanceUpdate[];       // Computed balance deltas (+1, -1)
  mintInfos: MintInfo[];                 // Metadata about new mints

  // Orders & Marketplace
  fillEvents: FillEvent[];               // Sales/Fills
  cancelEvents: CancelEvent[];           // Order cancellations
  bulkCancelEvents: BulkCancelEvent[];   // Mintevent/Nonce invalidations
  nonceCancelEvents: NonceCancelEvent[]; // Bit-vector cancellations
  
  // Orderbook Construction
  orderInfos: OrderInfo[];               // New on-chain orders (e.g., stored in calldata)
  makerInfos: MakerInfo[];               // Triggers to re-validate existing orders for a maker

  // Payments
  ftTransferEvents: FtTransferEvent[];   // ERC20 Transfers (WETH, USDC)
  
  // System
  shards: ShardUpdate[];                 // For DB sharding/partitioning logic
}
```

### 1. Inventory State

*   **`nft_transfer_events`**: Immutable log.
    *   `tx_hash`, `log_index`, `address` (contract), `from`, `to`, `token_id`, `amount`.
    *   *Constraint:* Unique on `(tx_hash, log_index, batch_index)`.
*   **`nft_balances`**: Current state.
    *   `contract`, `token_id`, `owner`, `amount`.
    *   *Update Logic:* Upsert. `amount = amount + delta`.
    *   *Optimization:* During backfill, writes are serialized to avoid row locking contention.

### 2. Order State

*   **`orders`**: The Orderbook.
    *   `id` (hash), `kind` (seaport, etc.), `maker`, `taker`, `price`, `valid_from`, `valid_until`.
    *   `fillability_status`: 'fillable', 'filled', 'cancelled', 'expired', 'no-balance'.
*   **`fills`**: Sales history.
    *   `order_id`, `maker`, `taker`, `price`, `timestamp`.
    *   *Logic:* When a fill event occurs, the associated order in `orders` must be updated to `filled` (or partial fill quantity updated).

### 3. Maker Info (Trigger Pattern)

A key pattern for keeping the orderbook up-to-date without polling is the **Maker Trigger**.

*   **Concept:** Any on-chain event that changes a user's ability to fulfill an order (Balance Transfer, Approval Change) produces a `MakerInfo`.
*   **Payload:** `{ maker: "0xUser", contract: "0xNft", tokenId: "123" }`.
*   **Downstream Action:** A job `OrderUpdatesByMaker` picks this up, queries *all* active orders for this user/token, and re-validates them (checks balance/allowance). If validation fails, order status -> `no-balance`.

## Domain Event Definitions

### NftTransferEvent
```json
{
  "kind": "erc721",
  "from": "0xAlice",
  "to": "0xBob",
  "tokenId": "1",
  "amount": 1,
  "baseEventParams": {
    "block": 100,
    "txHash": "0x..."
  }
}
```

### FillEvent
```json
{
  "orderKind": "seaport",
  "orderId": "0xOrderHash", // if known, or derived
  "maker": "0xAlice",
  "taker": "0xBob",
  "price": "1.5",
  "currency": "0xWETH"
}
```
