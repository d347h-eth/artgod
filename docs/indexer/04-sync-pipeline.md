# Sync Pipeline

The sync coordinator acquires and applies contiguous onchain prefixes. Historical
imports share acquisition and storage, but cannot mutate current ownership or
order state. Queue messages wake the owner or request historical enrichment.

Primary files:

- `indexer/src/runtime/sync-worker.ts`
- `indexer/src/application/sync.ts`
- `indexer/src/application/sync-range-processing.ts`
- `indexer/src/domain/onchain.ts`
- `indexer/src/abi/index.ts`

## Sync Jobs

Sync jobs are defined in `indexer/src/domain/sync-jobs.ts`:

- `sync.realtime.block` with payload `{ blockNumber }`
- `sync.backfill.range` with payload `{ fromBlock, toBlock, source }`

Backfill `source` is `manual_historical` or `bootstrap_catchup`. The source
selects the ingress behavior; no second maintenance-policy field exists.

The scheduler retains remote head samples before publishing realtime wakeups.
Bootstrap retains its catch-up target and publishes one scoped wakeup. Their
handlers acknowledge promptly without acquiring blocks. Only `manual_historical`
queue requests acquire ranges directly, through Historical writer acceptance.
Automatic gap/reorg ranges belong to retained SQLite intent and the coordinator;
they have no producer or accepted payload on this queue.

## Sync Worker Flow

The sync runtime has one current-state coordinator (`AutomaticSyncExecutor`),
realtime/backfill queue adapters, and the existing historical gap scanner.

1. The coordinator resumes retained recovery and checks a due canonical identity
   before selecting forward work. Explicit disputes and ancestor recovery gate
   current progress; ordinary delayed maturity checks do not.
2. An installed ownership base supplies the initial shared anchor. Selecting a
   bootstrap anchor alone cannot initialize progress. Additional installed bases
   inside that prefix reuse its exact header. A slow bootstrap with an older
   installed base receives fresh anchor verification and bounded collection-only
   replay until it joins the exact shared base. Shared authority never moves
   backward; validation remains unavailable below that join.
3. Each pass acquires one bounded range: either the next shared-chain prefix or
   the next collection prefix through already accepted shared history. Empty
   blocks still advance with complete linked headers. Per-scope retry times and
   alternating shared/scoped selection prevent one failed collection from
   starving other ready work.
4. `processSyncRange()` acquires logs, extension facts, transactions/receipts and
   fresh canonical headers, then builds follow-ups. `SqliteSyncRangeCommit`
   atomically validates the expected predecessor, revision and scope, writes
   facts, applies ownership and canonical order effects, retains required outbox
   rows, and advances only those prefixes. No RPC or broker call is in the writer.
5. Domain-worker publishes retained follow-ups independently. Delayed publication
   cannot postpone core order invalidation or advance the applied checkpoint.
6. When foreground work is idle, enabled historical gap repair acquires a bounded
   facts-only range. Manual historical jobs use the same projection restriction.

Shared and scoped catch-up, bootstrap catch-up, recovery and current validation
use the main RPC lane. They continue when historical gap filling is disabled.
Historical acquisition uses `RPC_BACKFILL_URL_LIST` when configured; current
application uses `RPC_URL_LIST`. One acquired current range is held at a time,
with no speculative future buffer. The loop continues immediately after progress
and polls every 12 seconds when idle or waiting; wakeups shorten that wait.
`BACKFILL_WORKER_COUNT` controls manual historical queue concurrency.

Historical discovery retains its bounded backward scan, startup/newer-hole
checks, per-collection cursor and retry policy. These establish missing fact
coverage, not ownership or validation readiness. See
[historical gap repair](03-scheduler-worker.md#perpetual-collection-gap-repair).

### RPC allocation

`main` covers current shared/scoped application, manual backfills, bootstrap, reorg recovery and their
downstream work. Automatic collection-gap acquisition and historical metadata/extension work
use `gap_repair`. Needed current-order validation uses main after domain
relevance and saved-validation checks. The class is explicit in queued envelopes; maker demand-expansion continuations are
main. Per-order validation demand has one main execution lane. Historical maker
hints enter through a background admission slot and retain a main continuation
only for a current requirement. Needed validation is independent of the hint's
work class. Ordinary messages without a class retain main behavior.

The sole HEAD scheduler per chain owns an allocation scheduler over the existing
local NATS connection. All six RPC-bearing pipeline runtimes acquire a permit
for each actual network attempt, including retries. Cached results consume none.
In `RPC_RATE_LIMIT_MODE=limited`, `RPC_RATE_LIMIT_REQUESTS_PER_SECOND` and `RPC_RATE_LIMIT_BURST`
limit total pipeline traffic per endpoint across processes and pools. Endpoint
identity is an opaque hash of the normalized URL; credentials never enter
budget messages. Backend/trading retain their existing separate RPC policies.

`GAP_FILL_MODE=limited` reserves `GAP_FILL_RPC_REQUESTS_PER_SECOND` per endpoint
(default 1.5 RPS, burst one), and `GAP_FILL_RPC_MAX_IN_FLIGHT` caps concurrent
background attempts across all pipeline workers/endpoints (default three).
Main uses remaining capacity and may borrow unused background allowance.
Limited background work cannot borrow extra main capacity.

`GAP_FILL_MODE=disabled` pauses automatic discovery/repair and defers queued
background RPC work while retaining unfinished work. Recovery, manual work and
admitted current-order validation remain main. `GAP_FILL_MODE=unlimited` removes
both gap-specific caps, yields to eligible waiting main requests, and still obeys
the overall RPC limit. `RPC_RATE_LIMIT_MODE=unlimited` removes that overall rate
and burst limit; a limited gap policy still applies independently. Selecting both
unlimited modes removes all configured RPC rate and gap concurrency caps.
Numeric settings must remain positive even when inactive; zero and negative
sentinels are invalid. These are startup settings; saved changes require restart.

Downstream queues use separate durable main/background slots for the same
handlers, so waiting background work cannot occupy a main slot. Background
deliveries renew their broker lease and retain quota waits without DLQ exhaustion.
Actual failed background descendants retry after five minutes and do not use
broker delivery counts to terminalize extension tasks; manual/bootstrap retry
limits retain their existing behavior.
Order validation uses both existing permits for needed current-order work in
main. Historical hints are filtered/coalesced before requiring RPC validation.

Budget messages are transient request/reply, outside the durable jobs stream.
Installed desktop uses the native NATS protocol over its existing loopback TCP
connection. Each metrics-enabled client samples broker PING/PONG and a
quota-independent allocator reply every five seconds; see
[coordination measurements](10-observability-and-metrics.md#rpc-coordination-health).
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
for allocated pipeline calls; wait is reported separately. RPC metrics now
separate work classes, and the owner exports waiting/active counts and ceilings.
Durable main backlog/coverage measurements and live free-public-RPC qualification remain required before
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

NFT approval logs are decoded into collection-scoped order revalidation hints: ERC721 `Approval` emits an exact-token maker trigger, while ERC721/ERC1155 `ApprovalForAll` emits collection-scoped maker triggers for the tracked contract. WETH transfer/approval logs are decoded into global maker triggers (`erc20-balance`, `approval-change`) to re-validate bids. These hints have no raw event table. Shared applied ranges acquire WETH and
Seaport global effects independently of the buy-side bidder index; the commit
retains canonical maker invalidation before advancing shared progress. Scoped
ranges retain their token/collection effects before advancing that collection.
Optional queue follow-ups use the same effect classifier. Historical imports
retain no current-order invalidation or maker-validation work.

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

## Historical Gap Check

The sync coordinator runs [perpetual collection gap repair](03-scheduler-worker.md#perpetual-collection-gap-repair)
when foreground work is idle. Collection coverage records successfully imported
facts; it cannot establish an applied prefix or satisfy bootstrap completion.

Repairs retain explicit collection IDs, repair identities, anchors and bounds.
The executor reloads them and plans one bounded common suffix. The transaction
writes historical facts, scoped activity follow-ups and the matching repair
remainder together. Current balances, orders, metadata and applied progress do
not change. Failed publication retries outbox intent without repeating RPC.
Pause, anchor changes, completion or purge invalidate a repair member before
commit. Queued automatic hints never execute these ranges independently.

## Persisting Sync Results

`SqliteSyncRangeCommit` owns the transaction around
`SqliteStorage.persistSyncResult()` and applied progress:

- Every fact and hint must reference a supplied header with the same height/hash.
  Headers cover the entire range, including empty blocks, and parent links match.
- Applied ranges start exactly after their captured predecessor. Shared ranges
  install the next accepted headers; collection-only replay uses identities
  already accepted by shared progress. A stored mismatch requires recovery.
- Historical imports cannot install future accepted headers or apply current
  effects. Existing accepted identities must match.
- Transfers/fills and collection fact coverage remain idempotent. Current
  ownership is applied once per newly accepted collection prefix, even if its
  facts were previously imported by a historical request.
- ERC721 projection reads only history through the accepted range end and its
  ownership checkpoint. ERC1155 deltas apply once under the same prefix fence.
- Canonical fills, cancellations and validation invalidations commit before the
  checkpoint is exposed, together with their required downstream intent.
- Rejected candidates change no facts, current effects, outbox or applied progress.

The sync worker captures the chain sync revision before fetching RPC data.
Persistence checks that revision in the same write transaction as facts, coverage
and balances. A rollback advances it, so an earlier in-flight sync cannot restore
orphaned facts after rollback.

Header reads bypass the RPC block cache. Rechecking the range tip after all
headers catches a reorg during those reads, including an empty-log range. A
conflict retries the queue request or defers automatic intent; no acquisition
progress or required follow-up is committed. A stored-header hash disagreement
also retains an explicit canonical check after the failed transaction exits,
including for mature history or a previously completed check. Ordinary revision,
range and acquisition-ownership conflicts do not rearm verification. The existing
sync coordinator freshly checks the stored identity and owns any rollback/resync.
Changes after the final RPC check remain the responsibility
of the sync coordinator; external chain state cannot be frozen by a SQLite transaction.

Historical backfill is facts-only at every height, including after a collection
anchor. Current effects require an explicitly accepted contiguous application;
raw coverage and an anchor comparison cannot grant that authority.

## Domain Job Fan-Out

The acquisition transaction retains domain follow-ups with an explicit projection split:

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
    - published only for accepted collection application with `projection = current_state`

Canonical order effects are retained directly in the same writer before applied
progress advances. By-ID effects update protocol state or ordinary validation
demand without another broker delivery. Maker effects perform an indexed
candidate existence check; an admitted scope retains one existing compact
continuation. Repeated effects coalesce into that scope and its current wakeup.
Unknown WETH owners create no order outbox message and no maker run. WETH logs
are read once per shared applied range; no bidder cache gates correctness.

Historical ranges emit activity follow-ups only. Maker handlers expand durable
per-order demand; validators read a coordinator checkpoint and cannot advance it.
Bootstrap wakeups do not acquire independently; completion observes both accepted
prefixes. The coordinator's single-flight execution owns current acquisition
serialization; historical facts-only work relies on its explicit writer contract.

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
threshold. This future run manager must remain facts-only. Post-anchor current application
already belongs to the coordinator and its durable ordered-prefix fence; see
[bootstrap execution](17-bootstrap-execution-and-concurrency.md#10-applied-catch-up).

Before implementation, decide which runtime owns the feeder, whether the first
model supports both chain-wide and collection-scoped runs, the default admitted
window, and run-history retention. The existing `BackfillSyncPayload` source and
Historical writer boundary remain authoritative throughout.

The current Admin action always schedules historical enrichment. A later
operator surface should expose that historical intent in run/status output rather than
making operators infer it. Any future current-state repair command must retain requirements for the existing
coordinator instead of granting a historical job projection authority. A direct
collection-, maker-, or orderbook-scoped command to revalidate current local
orders is preferable to replaying months of historical triggers for repair.
