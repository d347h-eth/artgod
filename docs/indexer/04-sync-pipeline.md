# Sync Pipeline

The sync pipeline consumes block sync jobs, fetches on-chain data, persists it, and fans out domain jobs plus targeted order update jobs.

Primary files:

- `indexer/src/runtime/sync-worker.ts`
- `indexer/src/application/sync.ts`
- `indexer/src/domain/onchain.ts`
- `indexer/src/abi/index.ts`

## Sync Jobs

Sync jobs are defined in `indexer/src/domain/sync-jobs.ts`:

- `sync.realtime.block` with payload `{ blockNumber }`
- `sync.backfill.range` with payload
  `{ fromBlock, toBlock, source, orderMaintenancePolicy }`

Backfill `source` identifies whether the range is `manual_historical`,
`reorg_recovery`, `bootstrap_catchup`, or `gap_repair`.
`orderMaintenancePolicy` is `current_state` for repair/catch-up work and
`skip_global_maker_revalidation` for manual historical enrichment.

These jobs are published by the scheduler-worker (realtime), backend manual
blockspace backfill, reorg recovery, bootstrap catch-up, and realtime gap repair.

## Sync Worker Flow

The sync worker:

1. Loads config and runs migrations.
2. Connects to NATS and the RPC provider.
3. Consumes realtime and backfill queues (one consumer each; backfill can run multiple safe in-flight jobs).
4. For each job:
    - Fetches logs for the target block/range.
    - Resolves enabled collection-extension watch specs for the targeted collections.
    - Fetches full block details for the same range.
    - Persists results via SQLite storage.
    - Publishes domain sync jobs (orders, metadata, activities), collection-scoped metadata refresh jobs, and order update jobs.

Realtime sync uses `maxInFlight = 1` to keep block processing strictly ordered.
Backfill sync uses configurable `BACKFILL_WORKER_COUNT` in-flight jobs.
The backfill worker classifies each job by collection anchor before execution:

- ranges fully at or before the affected collection anchors run as parallel facts-only work
- ranges that may touch current-state projection are serialized inside the worker
- jobs without settled anchors are not treated as parallel-safe

Backfill jobs use the `RPC_BACKFILL_URL_LIST` endpoint pool when configured; realtime jobs always use the `RPC_URL_LIST` endpoint pool.
Realtime sync targets live collections and anchored bootstrapping collections so collection-scoped blockspace coverage keeps moving while bootstrap work is still in progress.

## Log Fetching and Decoding

The sync logic lives in `indexer/src/application/sync.ts`:

- Uses viem `getLogs()` with `events` filtering across transfer events, ERC-4906 metadata refresh logs, Seaport logs, and collection-extension watch specs.
- Supports both ERC721 and ERC1155 transfers.
- Logs are decoded with `decodeEventLog` against the ABI defined in `indexer/src/abi/index.ts`.
- Each log is converted into a minimal `EnhancedEvent` structure containing:
    - Base params (block, tx, log index, contract).
    - Decoded params (from, to, tokenId, amount, standard).

The resulting data is returned as:

```
OnChainData = {
  transactions: TransactionRecord[];
  collectionScoped: {
    nftTransferEvents: NftTransferEvent[];
    nftBalanceDeltas: NftBalanceDelta[];
    fillEvents: FillEvent[];
    orderInfos: OrderInfo[];
    makerTriggers: TokenScopedMakerTrigger[];
    metadataRefreshEvents: MetadataRefreshEvent[];
    metadataRefreshRangeEvents: MetadataRefreshRangeEvent[];
  };
  global: {
    cancelEvents: CancelEvent[];
    makerTriggers: GlobalMakerTrigger[];
  };
}
```

Collection-scoped events are resolved to a concrete `collectionId` inside `sync.ts` before they leave the sync boundary. Only broader invalidation signals stay in the `global` bucket.

Balance deltas are produced for each transfer event. ERC721 generates +/-1 deltas; ERC1155 uses the transfer amount.

## Transaction Grouping

Before accumulating `OnChainData`, decoded events are grouped by transaction hash and sorted by log index (and batch index for ERC1155 batches). The sync worker fetches each transaction once and keeps the grouped order stable for future domain handlers that need atomic, tx-scoped processing.

Transactions associated with transfer events are persisted into SQLite so downstream order-fill logic can reuse calldata without re-fetching.

Each transaction is also paired with its receipt logs. The receipt logs are not persisted, but they are used during fill decoding to read protocol fill events and to correlate those events with tracked NFT transfer hops.

Seaport fills are decoded from receipt `OrderFulfilled` logs (no traces) and emitted as collection-scoped `fillEvents` when the protocol fill contains a tracked NFT and maps to a tracked NFT transfer in the same transaction. Matched buy/sell mirror logs for one NFT transfer are canonicalized to one fill; multi-hop bundles can emit multiple fills. Blur fills are decoded from supported calldata methods. See `docs/indexer/15-fill-decoding.md` for the full fill-decoding policy and edge cases. Seaport cancels (`OrderCancelled`) and order validations (`OrderValidated`) are decoded from Seaport logs and emitted into `global.cancelEvents` / collection-scoped `orderInfos` (criteria-based orders are skipped for now). Counter increments emit global maker triggers (`order-counter`).

NFT approval logs are decoded into collection-scoped order revalidation hints: ERC721 `Approval` emits an exact-token maker trigger, while ERC721/ERC1155 `ApprovalForAll` emits collection-scoped maker triggers for the tracked contract. WETH transfer/approval logs are decoded into global maker triggers (`erc20-balance`, `approval-change`) to re-validate bids. These triggers are **ephemeral** and only emitted when the order-maintenance policy allows current-state maker revalidation and the bidder index is ready and non-empty (quiet default). When the policy is `skip_global_maker_revalidation`, or when the index is empty/not yet loaded, WETH logs are skipped and no maker triggers are emitted.

Maker triggers are re-validation hints, not unconditional cancels. NFT transfers, single-token NFT approvals, and fill-derived item movements emit token-scoped maker triggers. NFT operator approvals emit collection-scoped maker triggers. WETH transfer/approval triggers and Seaport counter bumps stay global.

## Collection Extension Watch Specs

`sync-worker` asks the collection-extension install registry for enabled installs on the collections in the current range, resolves the concrete extension implementation, and collects `CollectionExtensionSyncWatchSpec[]`.

Each watch spec defines:

- `sourceId`
- one address or an address set
- event filters
- a decode function that normalizes raw logs into internal metadata refresh events/ranges and optional immutable extension event facts

The sync pipeline executes those extra `getLogs()` calls separately from the core transfer / ERC-4906 / Seaport queries. Metadata refresh outputs merge into the collection-scoped metadata refresh fanout path; extension event facts persist to `collection_extension_events` and can be projected into facts-only activity rows.

Current Terraforms watch specs:

- `terraforms-main`
    - watches `Daydreaming` and `Terraformed` on the main contract
- `terraforms-token-uri-v2`
    - watches `AttunementSet` on the v2 token URI contract
- `terraforms-beacon-v2`
    - watches `ParcelModified` on the v2 beacon contract

All of these normalize to token-level metadata refresh events with:

- `collectionId` already resolved from the install
- `reason = "collection-extension"`
- `trigger = "terraforms.extension-event"`

The `Terraformed` log also emits an extension event fact. The Terraforms extension owns the block-scoped contract reads needed to attach the committed canvas rows, maker address, and content hash to that fact.

## Gap Check

After persisting a realtime block, the sync worker checks whether the previous block exists in SQLite. If it is missing, the worker enqueues a single-block `gap_repair` backfill job with `current_state` order maintenance to close the gap.

## Persisting Sync Results

`SqliteStorage.persistSyncResult()`:

- Writes blocks to `blocks` table.
- Marks each processed block in `collection_sync_blocks` for every collection the sync job actually targeted.
- Inserts transfer events into `nft_transfer_events`.
- Inserts fill events into `fills`.
- Applies balance updates for newly inserted transfers only when the event block is strictly after the affected collection's `bootstrap_anchor_block`.

The storage layer is idempotent:

- Transfers are inserted with `INSERT OR IGNORE` against a unique constraint.
- Collection block coverage is upserted by `(chain_id, collection_id, block_number)`.
- Balances are updated only for transfers that were newly inserted.

This is the key ownership invariant for historical backfill:

- raw facts are always persisted for the requested range
- current-state tables are anchor-gated
- `block <= bootstrap_anchor_block` is facts-only and must not mutate `nft_balances`

## Domain Job Fan-Out

After persistence, each sync job triggers domain jobs with an explicit projection split:

- `domain.orders.sync`
- `domain.metadata.sync`
- `domain.activity.sync`

These jobs carry:

- `fromBlock`, `toBlock`
- `mode` (realtime or backfill)
- `projection` (`facts_only` or `current_state`)
- `sourceJobId`, `sourceKind`

See `indexer/src/runtime/sync-worker.ts` for the exact payloads.

Current behavior:

- `domain.activity.sync`
    - always receives the full raw range with `projection = facts_only`
    - activities are a historical-safe feed projection over persisted facts
- `domain.metadata.sync`
    - published only for the post-anchor window with `projection = current_state`
- `domain.orders.sync`
    - published only when the range intersects the post-anchor window
    - currently remains a placeholder, but order update fanout from the sync worker is still anchor-gated

Order maintenance then continues through dedicated update queues:

- `orders.update-by-maker`
- `orders.update-by-id`

`orders.update-by-maker` now carries a discriminated scope:

- token-scoped updates include `collectionId + tokenId`
- collection-scoped updates include `collectionId` only
- global updates carry maker-wide invalidation reasons only

Manual historical backfills keep token-scoped order maintenance but suppress
global `orders.update-by-maker` jobs for WETH balance, approval, and Seaport
counter triggers. Current-state repair backfills keep the global fanout.

The collection bootstrap worker also uses the sync pipeline for short-range bootstrap backfill. These bootstrap-published backfill jobs are collection-scoped so completion checks only track the intended collection.

## Current Limits and Future Direction

- Onchain order creation capture is still limited; the fully implemented orderbook path today is the separate OpenSea offchain pipeline (stream + snapshot/reconcile).
- ERC1155 balances are derived from deltas only after the bootstrap anchor. Historical backfill before the anchor enriches raw history but intentionally does not rewrite current balances.
- Collection-extension sync hooks are intentionally narrow in v1. They can request extra logs and emit metadata refresh events/ranges, but they do not yet publish broader domain actions.
- Zero-log responses are not blanket-retried. A future retry must use a targeted
  provider/eventual-consistency predicate so genuinely empty ranges do not loop.
- Transaction receipts are fetched conservatively. Provider-capability-gated
  batch or full-block transaction modes remain future backfill optimizations.
- `nft_balances` writes are transactional but do not use a separate historical
  write-buffer lane.

### Large Manual Backfills

The backend currently validates a requested range, splits it into configured
chunks, and publishes those chunks directly. That is appropriate for bounded
operator ranges. It is not a durable run manager for millions of blocks: there
is no persisted parent run, deterministic feeder cursor, pause/resume state, or
bounded JetStream admission loop.

The current large-range risks are explicit:

- the request remains open while the complete fan-out is published;
- a mid-publish failure leaves no durable record of which prefix was accepted;
- nonce-bearing manual job ids make a repeated request a new fan-out rather
  than an idempotent resume;
- JetStream retention and maximum age, not an application run model, determine
  how long unfinished intent survives;
- small queued ranges and a deliberately serial worker produce excessive queue
  overhead for multi-year history.

If that scale is required, retain one historical-sync path but put a durable run
model in front of it:

1. The scheduling use case commits a parent run and its intended chain,
   optional collection scope, block range, logical job size, status, feeder
   cursor, progress counts, timestamps, and last error, then returns quickly.
2. Durable run-job rows own each range window and its publish/execution state.
3. A bounded feeder publishes only a configured amount of pending work, using a
   deterministic identity derived from the run and exact block window.
4. SQLite state is committed before the broker wake-up; a periodic recovery scan
   republishes pending work after a missed publish or restart.
5. Worker completion advances durable progress and supports explicit pause,
   cancel, resume, and retry-failed operations without duplicating completed
   windows.

Logical execution job size must remain separate from the RPC adapter's internal
`LOG_CHUNK_SIZE`, so large jobs can reduce broker fan-out while each provider
request stays within its limits. The scheduling surface should show the
estimated job count and require explicit confirmation above a configured
threshold. Post-anchor current-state application remains ordered even if
facts-only historical work later gains safe parallelism.

Before implementation, decide which runtime owns the feeder, whether the first
model supports both chain-wide and collection-scoped runs, the default admitted
window, and run-history retention. The existing `BackfillSyncPayload` source and
manual order-maintenance policy remain authoritative throughout.

The current Admin action always schedules historical enrichment. A later
operator surface should expose that policy in run/status output rather than
making operators infer it. If ArtGod adds an explicit current-state repair mode,
it should remain a separate typed choice and guard Seaport counter fan-out by
the presence of local Seaport orders, not by the buy-side bidder index. A direct
collection-, maker-, or orderbook-scoped command to revalidate current local
orders is preferable to replaying months of historical triggers for repair.
