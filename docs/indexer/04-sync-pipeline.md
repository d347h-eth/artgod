# Sync Pipeline

The sync pipeline consumes block sync jobs, fetches on-chain data, persists it, and fans out domain jobs plus targeted order update jobs.

Primary files:

- `indexer/src/runtime/sync-worker.ts`
- `indexer/src/application/sync.ts`
- `indexer/src/application/sync-range-processing.ts`
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

The scheduler publishes realtime jobs; the backend and bootstrap worker publish
manual/bootstrap ranges. Automatic collection gaps and canonical reorg resync
are retained in SQLite and executed directly in the sync runtime. Backfill
source/member validation remains at the queue boundary so old or inconsistent
automatic hints cannot widen collection selection. Old automatic jobs are
acknowledged without RPC; their durable SQLite owner remains executable.

## Sync Worker Flow

The sync worker runs two queue consumers and one automatic executor:

1. Realtime jobs run with one in-flight block and target live/anchored bootstrap
   collections. Manual/bootstrap backfills keep configurable concurrency, with
   pre-anchor facts-only ranges parallel and current-state ranges serialized.
2. `AutomaticSyncExecutor` executes at most one bounded range per pass. Ready
   reorg resync takes priority; otherwise it shares the newest pending height's
   ready common suffix. That height keeps priority during retry backoff or when
   it exceeds the RPC head. Older automatic history waits.
3. All three paths use `processSyncRange()`: acquire logs, extension watch facts,
   policy-enabled WETH hints, transactions/receipts and fresh canonical headers;
   build required follow-ups; commit the complete result through
   `SyncRangeCommitPort`.
4. `SqliteSyncRangeCommit` validates current ownership/revision and commits facts,
   coverage, balances, required outbox rows and automatic acquisition progress in
   one transaction. No RPC or broker call happens inside that writer.
5. Domain-worker publishes due outbox rows independently. A publication outage
   or lost reply retries stable identities without repeating remote acquisition.

Automatic and queued backfills use `RPC_BACKFILL_URL_LIST` when configured;
realtime uses `RPC_URL_LIST`. Automatic repair starts immediately and continues
after each successful batch or local discovery page with older history still
to check. It waits 12 seconds only when idle, paused or blocked. Discovery runs
beside repair in the sync worker and does not depend on a scheduler tick.

A local-only discovery page may reuse HEAD for at most 12 seconds. Every batch
that fetches block data reads fresh HEAD before selection. Persisted 30-minute
checks can replace older pending ranges inside the shared current-state gate.
A running range finishes first; queued manual/recovery work gets the gate before
another automatic gap pass. Selection is repeated after waiting for that gate.
The loop drains admitted work before dependencies close; realtime stays outside
the gate. `BACKFILL_WORKER_COUNT` applies to queued manual/bootstrap backfills.
Automatic gaps still use one shared range at a time.

### RPC allocation

`main` covers realtime, manual backfills, bootstrap, reorg recovery and their
downstream work. Automatic collection-gap acquisition and historical metadata/extension work
use `gap_repair`. Needed current-order validation uses main after domain
relevance and saved-validation checks. The class is explicit in queued envelopes; maker validation continuations are
main. Per-order validation demand has one main execution lane. Legacy messages without a class retain
main behavior. Pending coalesced main demand promotes background demand; after
completion a new background request uses the background class again.

The sole HEAD scheduler per chain owns an allocation scheduler over the existing
local NATS connection. All six RPC-bearing pipeline runtimes acquire a permit
for each actual network attempt, including retries. Cached results consume none.
The existing `RPC_RATE_LIMIT_REQUESTS_PER_SECOND` and `RPC_RATE_LIMIT_BURST`
limit total pipeline traffic per endpoint across processes and pools. Endpoint
identity is an opaque hash of the normalized URL; credentials never enter
budget messages. Backend/trading retain their existing separate RPC policies.

`GAP_FILL_RPC_REQUESTS_PER_SECOND` limits background traffic per endpoint
(default 0.5, burst one), and `GAP_FILL_RPC_MAX_IN_FLIGHT` limits concurrent
background attempts across all pipeline workers/endpoints (default one).
Main uses remaining capacity and may borrow the background allowance when
unused. Background cannot borrow extra main capacity. A zero gap rate pauses
automatic discovery/repair and defers queued background RPC work; recovery and
manual work remain main. These are startup settings; saved changes require restart.

Downstream queues use separate durable main/background slots for the same
handlers, so waiting background work cannot occupy a main slot. Background
deliveries renew their broker lease and retain quota waits without DLQ exhaustion.
Actual failed background descendants retry after five minutes and do not use
broker delivery counts to terminalize extension tasks; manual/bootstrap retry
limits retain their existing behavior.
Order validation uses both existing permits for needed current-order work in
main. Historical hints are filtered/coalesced before requiring RPC validation.

Budget messages are transient request/reply, outside the durable jobs stream.
Transport waiters and attempt leases are bounded; a caller can rejoin quota
admission while preserving its selected request and earlier reads. This permits
slow configured rates without restarting the whole range. Pausing or shutdown
still releases ownership. Crashed callers lose their permits after
the configured HTTP timeout plus five seconds. A new owner waits that long before
granting background work, fencing attempts from the previous owner. Main startup
uses the established per-client limiter only when NATS reports no budget owner;
background never bypasses its allocation. This assumes the normal composition's
single HEAD scheduler per chain, not replicated independent budget owners.
The owner performs asynchronous head scheduling; SQL history scans stay in the
sync worker so they cannot block admission for other pipeline processes.

#### Deferred automatic allocation

A future controller belongs in that budget owner, underneath the manual ceilings.
Use main backlog age, local quota wait, provider response time excluding that wait,
timeouts/rejections and achieved throughput. Reduce background quickly under main
pressure and increase it slowly with hysteresis; do not add persisted gap state
or weaken snapshot/canonical checks. Endpoint attempt timing excludes quota wait
for allocated pipeline calls; wait is reported separately. Purpose-separated
measurements and live free-public-RPC qualification remain required before
enabling automatic adjustment.

Acquisition completion establishes persisted data and publication intent.
Publication acceptance and downstream consumer completion are separate states.
Reorg eligibility is reloaded inside the gate; an empty eligible set stays
pending. These checks do not establish full lifecycle cancellation.

## Log Fetching and Decoding

`ViemRpcProvider` separates a sync job's logical range from its RPC request
windows. Requests initially use at most `LOG_CHUNK_SIZE` blocks. If viem rejects
a response with `ResponseBodyTooLargeError`, the adapter halves the failed
window and retries from its first block. Completed windows are kept, and the
cursor advances only after a window succeeds, preserving complete ordered logs
without skipped or repeated intervals. This also protects retained backfills
created under a larger `BACKFILL_BATCH_SIZE`.

The learned cap can only decrease during that provider instance's lifetime and
is shared by its concurrent and later calls. Primary and dedicated backfill
providers learn independently; no saved setting, durable job, or other process
is rewritten. A restart starts with the configured cap again. An error log
records the failed range, byte limit, response size and new cap, and recommends
reducing `BACKFILL_BATCH_SIZE` or `LOG_CHUNK_SIZE`. If one block still exceeds the
limit, acquisition rejects explicitly. Other transport failures retain the
normal endpoint retry policy.

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

Receipt reads bypass the cache so retry can observe a transaction moved to the
new branch. Receipt transaction identity and each receipt log's block identity must match
the transfer logs before fill decoding. A receipt fetched from another branch
rejects the sync attempt instead of attributing orphaned fill facts to its block.

Seaport fills are decoded from receipt `OrderFulfilled` logs (no traces) and emitted as collection-scoped `fillEvents` when the protocol fill contains a tracked NFT and maps to a tracked NFT transfer in the same transaction. Matched buy/sell mirror logs for one NFT transfer are canonicalized to one fill; multi-hop bundles can emit multiple fills. Blur V2 fills come from receipt execution events correlated to tracked NFT transfers, including direct and routed calls. See `docs/indexer/15-fill-decoding.md` for the full fill-decoding policy and edge cases. Seaport cancels (`OrderCancelled`) and order validations (`OrderValidated`) are decoded from Seaport logs and emitted into `global.cancelEvents` / collection-scoped `orderInfos` (criteria-based orders are skipped for now). Counter increments emit global maker triggers (`order-counter`).

NFT approval logs are decoded into collection-scoped order revalidation hints: ERC721 `Approval` emits an exact-token maker trigger, while ERC721/ERC1155 `ApprovalForAll` emits collection-scoped maker triggers for the tracked contract. WETH transfer/approval logs are decoded into global maker triggers (`erc20-balance`, `approval-change`) to re-validate bids. These hints have no raw event table, but required follow-up envelopes are retained
atomically in the outbox. They are only emitted when the order-maintenance policy allows current-state maker revalidation and the bidder index is ready and non-empty (quiet default). When the policy is `skip_global_maker_revalidation`, or when the index is empty/not yet loaded, WETH logs are skipped and no maker triggers are emitted.

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

The sync worker performs [perpetual collection gap repair](03-scheduler-worker.md#perpetual-collection-gap-repair)
on startup and every HTTP head poll. It repeatedly walks collection-specific
coverage from head through each live collection's bootstrap anchor, including
holes behind bootstrap's last-synced block. The former global predecessor check
has been removed.

Repairs retain explicit collection IDs, repair identities, anchors and bounds.
The direct executor reloads them, plans one bounded common suffix and calls the
same multi-collection pipeline once. Each member gets scoped activity/order/
metadata range follow-ups with a stable source identity derived from its repair
ID and acquired bounds. Shared order hints and metadata refreshes are built once.
Fully pre-anchor members receive activity projection only.

Atomic completion advances a matching intent to its older remainder or clears
it. Retrying publication cannot reset progress or repeat RPC acquisition; the
required outbox rows remain independently retryable. Pause, anchor changes,
completion or purge before commit invalidate a gap member and reject the whole
acquisition transaction. Legacy queued automatic hints do not execute ranges.

## Persisting Sync Results

`SqliteStorage.persistSyncResult()`:

- Validates that every fact and fanout hint references a supplied header with the
  same block number and hash. Adjacent headers must have matching parent links,
  and repeated heights must contain identical metadata.
- Rejects a hash conflicting with a stored block; canonical replacement requires
  rollback first. Validation failure writes no facts, coverage or balances.
- Writes blocks to `blocks` table.
- Marks each processed block in `collection_sync_blocks` for every collection the sync job actually targeted.
- Inserts transfer events into `nft_transfer_events`.
- Inserts fill events into `fills`.
- Applies balance updates for newly inserted transfers only when the event block is strictly after the affected collection's `bootstrap_anchor_block`.

The storage layer is idempotent:

- Transfers are inserted with `INSERT OR IGNORE` against a unique constraint.
- Collection block coverage is upserted by `(chain_id, collection_id, block_number)`.
- Balances are updated only for transfers that were newly inserted.
- For ERC721 tokens touched by new post-anchor transfers, ownership is projected
  from the latest persisted transfer by block number and log index, or the verified
  fork ownership checkpoint when it is at or after that transfer's block. Older repair
  ranges cannot restore a previous owner, leave multiple owners, or resurrect a
  token whose latest transfer burns it. ERC1155 deltas remain additive and are
  applied once per inserted transfer.

The sync worker captures the chain sync revision before fetching RPC data.
Persistence checks that revision in the same write transaction as facts, coverage
and balances. A rollback advances it, so an earlier in-flight sync cannot restore
orphaned facts after rollback.

Header reads bypass the RPC block cache. Rechecking the range tip after all
headers catches a reorg during those reads, including an empty-log range. A
conflict retries the queue request or defers automatic intent; no acquisition
progress or required follow-up is committed. Changes after the final RPC check remain the responsibility
of the reorg worker; external chain state cannot be frozen by a SQLite transaction.

This is the key ownership invariant for historical backfill:

- raw facts are always persisted for the requested range
- current-state tables are anchor-gated
- `block <= bootstrap_anchor_block` is facts-only and must not mutate `nft_balances`

## Domain Job Fan-Out

The acquisition transaction retains domain follow-ups with an explicit projection split:

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
- High-volume current-state `nft_balances` projection writes during catch-up or
  reorg recovery are transactional but do not use a separate write-buffer lane.
  Pre-anchor historical imports remain facts-only.

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
- small queued ranges and the default single-in-flight backfill worker produce
  excessive queue overhead for multi-year history.

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
threshold. The design must preserve current-state projection order across
post-anchor ranges, including retries. The current process-local backfill gate
serializes arrivals but does not establish a durable block-order barrier; see
[bootstrap execution](17-bootstrap-execution-and-concurrency.md#10-short-backfill).

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
