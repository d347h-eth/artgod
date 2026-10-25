# Queues and Jobs

This document covers the queue contract, job envelopes, and the NATS JetStream adapter used for durable job delivery.

## Queue Names

Queue names are defined in `indexer/src/domain/queues.ts`:

- `events-sync-realtime`
- `events-sync-backfill`
- `collection-bootstrap`
- `collection-bootstrap-image-cache`
- `opensea-bootstrap`
- `opensea-reconcile`
- `offchain-orders-raw`
- `orders-upsert`
- `order-updates-by-maker`
- `order-updates-by-token`
- `order-lifecycle-updates`
- `activity-upsert`
- `collection-extension-artifacts`
- `token-image-cache`
- `metadata-domain`
- `metadata-refresh`
- `metadata-stats`
- `activity-domain`
- `dead-letter`

These are treated as contract-level identifiers and are used across all runtimes.

## Job Envelope

Every job uses a shared envelope in `indexer/src/domain/jobs.ts`:

```
type JobEnvelope<TPayload> = {
  jobId: string;
  kind: string;
  queue: QueueName;
  payload: TPayload;
  attempt: number;
  scheduledAt: number;
  traceId?: string;
  collectionId?: number;
  chainId: number;
  workClass?: "main" | "gap_repair";
  onchainBlock?: { chainId: number; blockNumber: number; blockHash: string };
}
```

Key details:

- `jobId` is required and used for dedupe.
- `attempt` is updated by the queue adapter from delivery count.
- `scheduledAt` allows scheduling in the future by re-nacking with a delay.
- `onchainBlock` identifies event-specific sync hints. Domain-worker checks the
  stored canonical hash before handler admission; a late orphan hint is ACKed
  without processing. Range projection jobs reread persisted facts instead.

Automatic gap history processing retains `gap_repair`. The orders domain checks
relevance and saved validation results before admitting unmet current-order
validation to `main`; maker/token continuations and both ordinary demand
executors use main capacity. Envelopes without a work class default to `main`.
Main uses the existing exact queue subject; background appends
`.gap_repair` with a separate durable consumer named `<main-consumer>-gap_repair`.
Both execute the same handler with separate slots. Quota waits are local
deferrals, retained without terminal delivery-count exhaustion. Maker recovery
uses the persisted publication's class and checks both consumers' ACK floors.
The backlog inspector includes both exact subjects when selecting a logical
queue; an explicit `--subject` still selects only that subject.

## Queue Port (Interface)

All queue implementations must match `indexer/src/ports/queue.ts`:

- `publish(queue, message)`
- `subscribe(queue, handler, options)`
- `close()`

The handler receives `QueueMessage` with `ack`, `nack`, and `touch` functions.

## NATS JetStream Adapter

Implementation: `indexer/src/infra/queue/nats.ts`.

Behavior:

- Creates a single JetStream stream per `streamPrefix`.
    - Stream name: `${streamPrefix}-jobs`
    - Subjects: `${streamPrefix}.jobs.>`
- Retention policy: `Workqueue` (each message consumed once).
- Storage type: file-backed.
- No age expiry (`max_age: 0`). Valid pending work survives time offline.
- Backend publishers and indexer workers reconcile the same shared stream policy.

Startup maintenance runs on every desktop runtime start/restart, before normal
producers and consumers. It removes retained records only for an exact subject
owned by one durable, explicit-ACK, deliver-all consumer whose delivered prefix
is fully acknowledged. Retained records must be at or below that ACK floor;
pending records above it remain intact. In-flight, redelivering, ambiguous,
uncovered, or unsupported consumer state is never used to authorize cleanup.
The adapter rechecks stream/consumer identity and positions immediately before
a subject-and-sequence-bounded purge. Healthy queues require no cleanup.

Storage pressure or record age alone never permits deletion. If writes cannot
recover by removing acknowledged leftovers, startup fails and preserves queued
work. A generic `503`, unrelated API error, or probe-cleanup failure also fails
maintenance without deleting jobs. Failed connection initialization closes its
connection before returning the failure.

For existing installations, a native child disables the saved age limit before
NATS starts: NATS otherwise expires old records during restore, before the API
is available. This narrowly scoped metadata migration verifies NATS checksums
and journals the two-file update so an interrupted attempt can finish on retry.
It never changes message blocks or consumer state. See the
[desktop recovery lifecycle](../desktop/01-tauri-build-and-runtime.md#supervisor-runtime-composition).

This is startup recovery, not live repair or a durability guarantee for manual
backfills. No job is deleted merely because a manual backfill is older than a day.

Publishing:

- Each job is published to a subject derived from the queue name.
- `msgID` is set to the jobId for broker-level dedupe.
- Publication can return a stream-incarnation/sequence receipt. Durable maker
  continuations record it in the outbox so recovery can distinguish pending
  broker work from a publication whose delivery has already been acknowledged.

Subscribing:

- Durable consumer with explicit ack.
- Supports `maxInFlight` (maxAckPending).
- Supports `ackWaitMs`.
- Reconciles existing durable consumer `maxAckPending` / `ackWaitMs` on worker startup so runtime config changes take effect after relaunch.
- A simple limiter controls concurrency in-process.

The OpenSea reconciliation worker explicitly uses one in-flight job, a
30-second ACK deadline and 10-second lease renewals. Its automatic refresh
requests are rechecked for freshness at consumption, so obsolete queued hints
are acknowledged without another REST scan. See
[REST reconciliation freshness](07-domain-orders.md#rest-reconciliation-freshness).

## Queue Backlog Inspection

Use the read-only inspector when a JetStream consumer is backed up and the goal is to understand stored message shape without advancing a durable cursor:

```sh
yarn workspace @artgod/indexer run inspect:queue -- --queue order-updates-by-maker --limit 10000
```

The inspector reads stored messages through JetStream direct lookup (`STREAM.MSG.GET` with `next_by_subj`). It does not create a consumer, ack, nack, or change any existing consumer state. The JSON output groups decoded job envelopes by kind, queue, scope, reason, collection, block number, maker, transaction hash, and includes first/last samples for payload layout review.

## Retry and Dead-Letter Handling

Worker retry and DLQ behavior are handled in `indexer/src/application/worker-runner.ts`:

- If a job's `scheduledAt` is in the future, the worker nacks with delay.
- If a handler throws, the message is nacked.
- Source lifecycle consumers retain their original envelopes on application
  failure with a one-second retry delay; they have no attempt-based transfer to
  the log-only DLQ. Unsupported order jobs and malformed queue envelopes remain
  in their original queue with a 60-second retry delay and a visible error.
- The NATS adapter uses the SDK's one-based `deliveryCount` for `attempt` (the
  first delivery is attempt 1). Successful maker continuations are separate
  step messages; many successful steps do not exhaust a retry limit.
- A deferred maker lease wait nacks with delay without entering the DLQ path.
- Reorg checks retain their delivery through every pre-handoff failure, including
  database reads and RPC errors after earlier journal-write deferrals. Ordinary
  DLQ exhaustion becomes safe only after durable recovery takes ownership.
- Maker admission failures also retain the original delivery with a one-second
  delay, including unavailable delivery evidence or SQLite persistence. Before
  admission commits there may be no run for durable recovery to find.
- If `attempt >= maxAttempts` and a `deadLetterQueue` is configured:
    - A dead-letter job is published with the original job and error info.
    - The original message is acked (removed from the stream).

DLQ payload:

- Defined in `indexer/src/domain/dead-letter.ts`.

## Current Job Types

- Sync jobs (`indexer/src/domain/sync-jobs.ts`):
    - `sync.realtime.block`
    - `sync.backfill.range`

`sync.backfill.range` carries the current request source and range:

```ts
type BackfillSyncPayload = {
    fromBlock: number;
    toBlock: number;
    source: "manual_historical" | "bootstrap_catchup";
};
```

The decoder validates source, range and envelope before collection selection.
Manual historical requests acquire facts and activity only. Bootstrap requests
wake the coordinator, whose current Backfill authorization and applied prefixes
own current execution. Global and collection-scoped routing remain supported. No duplicate
order-maintenance policy or automatic gap/reorg wire format is retained.
Unknown or inconsistent input cannot acquire a range.

The sync runtime reads `collection_sync_gap_scans` and `chain_reorg_recoveries`
directly. Its one bounded serial executor shares a common pending gap suffix,
prioritizes ready canonical resync and revalidates the retained members/range.
The acquisition transaction writes data, required downstream outbox envelopes
and matching progress together. See [gap scheduling](03-scheduler-worker.md#perpetual-collection-gap-repair)
and [resync](06-reorg-handling.md#resync-after-rollback).

Required sync follow-ups use `retry_policy = required` and stable IDs qualified
by the chain revision. The outbox publisher retries them indefinitely with
capped backoff. A lost broker reply retries the same identity without remote
acquisition. Accepted sync follow-ups are removed; ordinary workflows keep their
bounded retry policy and sent receipts. Event-specific rows retain originating
block identity and are removed by rollback; DB range projections remain pending
because they reread canonical facts, including unfinished pre-fork work.

Realtime deliveries wake the serial coordinator and ACK without acquiring
blocks. The scheduler already retained the target; progress and retries survive
lost wakeups. Bootstrap backfill deliveries also wake this owner. Only manual
historical acquisitions hold a broker delivery during RPC and renew its lease
through `touch`.

Recent stored blocks retain hash checks in SQLite; the sync coordinator reads them
directly. A failed header read or mismatch-retention transaction leaves the
check pending with durable backoff. Recovery handoff retains the disagreement
atomically, without a check queue or DLQ.

- Domain jobs (`indexer/src/domain/domain-jobs.ts`):
    - `domain.metadata.sync`
    - `domain.metadata.refresh`
    - `domain.metadata.refresh-range`
    - `domain.metadata.stats-recompute`
    - `domain.activity.sync`

Domain sync payloads also carry an explicit projection contract:

- `projection = facts_only`
    - historical-safe projection only
    - used today for `domain.activity.sync`
- `projection = current_state`
    - may mutate current-state/materialized tables
    - used today for metadata fanout

This split matters for historical backfill. Pre-anchor ranges are still imported as raw facts, but only anchor-eligible post-anchor windows are allowed to publish current-state work.

- Order update jobs (`indexer/src/domain/order-jobs.ts`):
    - `orders.upsert`
    - `orders.update-by-maker`
    - `orders.continue-maker`
    - `orders.update-by-id`

Source ingestion emits upserts and source-specific lifecycle observations.
Canonical sync commits by-ID effects and validation demand directly in its writer;
it does not publish duplicate by-ID messages or an orders-domain range message.
A relevant canonical maker effect retains a run and one continuation atomically
with applied progress. An indexed candidate check inside that writer suppresses
empty scopes; there is no bidder cache or independent event publication filter.

`orders.update-by-maker` is a fresh scoped hint:

- token scope includes `collectionId` and `tokenId` and uses `order-updates-by-token`;
- collection scope includes `collectionId` and uses `order-updates-by-maker`;
- global scope omits collection/token attribution and uses `order-updates-by-maker`.

`orders.continue-maker` carries only `{ chainId, runId, step }`. The retained run
owns its scope, payload, finite selection boundary and generation. Resume checks
chain, owning queue and step; late delivery cannot recreate a deleted run. Both
maker consumers require delivery-origin evidence and enforce their scope route.
Main and gap consumers still have independent ACK floors, so a run may retain
multiple receipts even though its broad/token route is fixed.

Maker steps expand bounded pages into ordinary validation demand without RPC.
Cursor, demand and the next outbox continuation commit together. Preadmission
failure retains the original delivery. After admission, a failed step ACKs only
when its lease is durably released to recovery; uncertain release retries the
message. Periodic recovery owns missing-wakeup repair and bounded ACK-based
receipt cleanup. Publication success alone is not execution completion.

`orders.update-by-id` is the existing payload kind for source updates on
`order-lifecycle-updates`. Its handler requires source identity, collection and
observation time; scheduling time and outer envelope fields do not replace them.
Upserts and source updates retain observations and causal demand before ACK.
No source message asserts canonical completion. Canonical payloads are internal
writer inputs and are rejected on this source route. The obsolete standalone
`order-updates-by-id` queue and its admission pacing have no current producer or
consumer; old-format queue recovery is outside this implementation's scope.

Two bounded ordinary-demand executors share FIFO capacity for full RPC validation.
They claim only ready demand at a coordinator checkpoint, resume expired leases,
and yield between batches. Maker expansion and source admission use no validation
permits. SQLite transactions stay synchronous; they do not span RPC or permit
waits. Unsupported input remains visible and retained under the worker policy.
See the [operator procedure](18-order-queue-recovery.md) for useful-work inspection.

- OpenSea jobs (`indexer/src/domain/opensea-jobs.ts`):
    - `opensea.collection.bootstrap`
    - `opensea.collection.reconcile`

- Offchain ingestion jobs (`indexer/src/domain/offchain-jobs.ts`):
    - `offchain.order.raw`

- Activity projection jobs (`indexer/src/domain/activity-jobs.ts`):
    - `activities.upsert`

Offchain stream dispatch publishes `activities.upsert` to `activity-upsert`.
The domain worker consumes it separately from historical-safe
`domain.activity.sync` so source-event idempotency and open-row coalescing have a
dedicated boundary.

Metadata stats recompute jobs use `domain.metadata.stats-recompute` on
`metadata-stats`. Bootstrap finalization, canonical metadata refresh follow-ups,
and extension-artifact terminality publish this job only after their owning
state is committed.

`offchain.order.raw` jobs are produced by the OpenSea stream/bootstrap/reconcile workers and consumed by the offchain ingest worker. These payloads carry:

- `channel` (`stream`, `snapshot`, `reconcile`)
- `eventType`
- optional `orderId`
- optional `runId`
- `receivedAt` (local observation time)
- `sourceEventAt` (source-derived timestamp or `null`)
- raw source payload

OpenSea stream subscriptions select live collections with enabled stream
ingestion. Publication checks the current collection again for cached routes;
the raw consumer also drops deliveries when the collection is missing, no
longer live, or paused. Bootstrap does not retain stream deliveries for later
replay. The post-live REST snapshot and periodic reconciliation recover source
coverage eventually.

For incomplete OpenSea sold events, validated seller/token identifiers can still
produce an `orders.update-by-maker` hint on `order-updates-by-token` without an
exact-order filled update. Hashless sales use distinct NFT/seller/transaction
identities for stream deduplication; see
[OpenSea Sale Hints](07-domain-orders.md#opensea-sale-hints).

- Bootstrap jobs (`indexer/src/domain/bootstrap-jobs.ts`):
    - `bootstrap.collection.start`
    - `bootstrap.collection.metadata-process`
    - `bootstrap.collection.ownership-process`
    - `bootstrap.collection.image-cache-process`
    - `bootstrap.collection.backfill-check`

- Collection extension jobs (`indexer/src/domain/collection-extension-jobs.ts`):
    - `collection-extension.refresh-artifacts`
- Token image cache jobs (`shared/media/token-image-cache-jobs.ts`):
    - `token-image-cache.refresh-token`
    - `token-image-cache.refresh-collection`

`bootstrap.collection.start` jobs are produced by the backend after it creates a
durable run and planned steps. Admin creates that run through the bootstrap API;
the bootstrap worker consumes the wakeup and claims persisted work.
`bootstrap.collection.metadata-process` jobs drain durable metadata snapshot tasks from `bootstrap_metadata_snapshot_tasks`.
`bootstrap.collection.ownership-process` jobs drain durable ownership snapshot tasks from `bootstrap_ownership_snapshot_tasks`; ownership terminal failures fail collection bootstrap because ownership is required for liveness.
`bootstrap.collection.image-cache-process` jobs drain durable image-cache tasks from `bootstrap_image_cache_tasks` on the separate `collection-bootstrap-image-cache` queue so slow remote media hosts do not block ownership/backfill/live progress.
`bootstrap.collection.backfill-check` jobs are produced by the bootstrap worker to verify short backfill completion before switching a collection to `live`.

`collection-extension.refresh-artifacts` jobs are produced in two flows:

- by `bootstrap-worker` from the dedicated collection-extension step after the
  metadata snapshot settles, for metadata-derived and extension-owned tasks
- by `domain-worker` after canonical metadata writes during
  `domain.metadata.sync` and token or range refresh handling

These jobs are consumed by `collection-extension-worker` and carry:

- `chainId`
- `collectionId`
- `contract`
- `tokenId`
- `reason`
- optional `source`

The dedicated queue keeps collection-specific artifact retries isolated from canonical metadata throughput.

`token-image-cache.refresh-token` jobs are produced by `domain-worker` after metadata refresh when the collection image cache mode is `refresh_on_metadata`.

`token-image-cache.refresh-collection` jobs are produced by the backend when a collection image cache policy switches to an active mode or changes max dimension. They are consumed by `domain-worker` in cursor pages and produce settled `token_image_cache` rows.

OpenSea job production/consumption:

- `opensea.collection.bootstrap`
    - produced by `bootstrap-worker` after `collection_live`, or by the backend's explicit post-live OpenSea setup action
    - consumed by `opensea-bootstrap-worker`; a completed core bootstrap run can still have pending OpenSea side steps
- `opensea.collection.reconcile`
    - produced by `opensea-reconcile-scheduler-worker`
    - consumed by `opensea-reconcile-worker`

Collection extension job production/consumption:

- `collection-extension.refresh-artifacts`
    - produced by `bootstrap-worker` and `domain-worker`
    - consumed by `collection-extension-worker`

These jobs are produced by backend use cases and the scheduler, bootstrap, sync,
domain, collection-extension, OpenSea, and offchain-ingest runtimes. They are
consumed by the sync, domain, bootstrap, collection-extension,
offchain-ingest, and OpenSea runtimes.

## Current Limits and Future Direction

- Retry policy is bounded in the queue adapter and in several domain-owned task
  lifecycles, but it is not one universal policy. A future unification must keep
  domain terminality and operator recovery explicit rather than hiding them
  behind broker redelivery.
- Most consumers handle one envelope at a time. Queue-specific batch pulls are a
  future throughput tool only where handler idempotency, ordering, and ack
  semantics remain clear.
- The OpenSea stream worker refreshes per-slug subscriptions on a timer, but its
  event callback starts asynchronous queue publication without a project-owned
  bounded ingress buffer or explicit SDK connection-heartbeat supervisor.
- The read-only queue inspector reports stored-message counts and first/last
  message timestamps; there is no automatic queue-depth admission policy yet.
