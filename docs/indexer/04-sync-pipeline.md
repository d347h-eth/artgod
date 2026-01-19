# Sync Pipeline

The sync pipeline consumes block sync jobs, fetches on-chain data, persists it, and fans out domain jobs.

Primary files:

- `indexer/src/runtime/sync-worker.ts`
- `indexer/src/application/sync.ts`
- `indexer/src/domain/onchain.ts`
- `indexer/src/abi/index.ts`

## Sync Jobs

Sync jobs are defined in `indexer/src/domain/sync-jobs.ts`:

- `sync.realtime.block` with payload `{ blockNumber }`
- `sync.backfill.range` with payload `{ fromBlock, toBlock }`

These jobs are published by the scheduler (realtime) and by reorg recovery (backfill).

## Sync Worker Flow

The sync worker:

1. Loads config and runs migrations.
2. Connects to NATS and the RPC provider.
3. Consumes realtime and backfill queues (one worker each).
4. For each job:
   - Fetches logs for the target block/range.
   - Fetches full block details for the same range.
   - Persists results via SQLite storage.
   - Publishes domain sync jobs (orders, metadata, activities).

The worker uses `maxInFlight = 1` to keep block processing strictly ordered within each queue.

## Log Fetching and Decoding

The sync logic lives in `indexer/src/application/sync.ts`:

- Uses viem `getLogs()` with `events` filtering (Transfer events only).
- Supports both ERC721 and ERC1155 transfers.
- Logs are decoded with `decodeEventLog` against the ABI defined in `indexer/src/abi/index.ts`.
- Each log is converted into a minimal `EnhancedEvent` structure containing:
  - Base params (block, tx, log index, contract).
  - Decoded params (from, to, tokenId, amount, standard).

The resulting data is returned as:

```
OnChainData = {
  nftTransferEvents: NftTransferEvent[];
  nftBalanceDeltas: NftBalanceDelta[];
  transactions: TransactionRecord[];
}
```

Balance deltas are produced for each transfer event. ERC721 generates +/-1 deltas; ERC1155 uses the transfer amount.

## Transaction Grouping

Before accumulating `OnChainData`, decoded events are grouped by transaction hash and sorted by log index (and batch index for ERC1155 batches). The sync worker fetches each transaction once and keeps the grouped order stable for future domain handlers that need atomic, tx-scoped processing.

Transactions associated with transfer events are persisted into SQLite so downstream order-fill logic can reuse calldata without re-fetching.

## Persisting Sync Results

`SqliteStorage.persistSyncResult()`:

- Writes blocks to `blocks` table.
- Inserts transfer events into `nft_transfer_events`.
- Applies balance updates for newly inserted transfers.

The storage layer is idempotent:

- Transfers are inserted with `INSERT OR IGNORE` against a unique constraint.
- Balances are updated only for transfers that were newly inserted.

## Domain Job Fan-Out

After persistence, each sync job triggers domain jobs using the same range:

- `domain.orders.sync`
- `domain.metadata.sync`
- `domain.activity.sync`

These jobs carry:

- `fromBlock`, `toBlock`
- `mode` (realtime or backfill)
- `sourceJobId`, `sourceKind`

See `indexer/src/runtime/sync-worker.ts` for the exact payloads.

## Notes and Current Limitations

- The sync worker is minimal and focused on transfer events. Order capture is not yet implemented.
- ERC1155 balances are derived from deltas only; without full historical backfill, balances may be incomplete for tokens that existed before the indexed range.
