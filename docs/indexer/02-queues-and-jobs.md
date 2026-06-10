# Queues and Jobs

This document covers the queue contract, job envelopes, and the NATS JetStream adapter used for durable job delivery.

## Queue Names

Queue names are defined in `indexer/src/domain/queues.ts`:

- `events-sync-realtime`
- `events-sync-backfill`
- `block-check`
- `collection-bootstrap`
- `collection-bootstrap-image-cache`
- `opensea-bootstrap`
- `opensea-reconcile`
- `offchain-orders-raw`
- `orders-domain`
- `orders-upsert`
- `order-updates-by-maker`
- `order-updates-by-id`
- `collection-extension-artifacts`
- `token-image-cache`
- `metadata-domain`
- `metadata-refresh`
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
}
```

Key details:

- `jobId` is required and used for dedupe.
- `attempt` is updated by the queue adapter from delivery count.
- `scheduledAt` allows scheduling in the future by re-nacking with a delay.

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
- Max age: 7 days.

Publishing:

- Each job is published to a subject derived from the queue name.
- `msgID` is set to the jobId for broker-level dedupe.

Subscribing:

- Durable consumer with explicit ack.
- Supports `maxInFlight` (maxAckPending).
- Supports `ackWaitMs`.
- Reconciles existing durable consumer `maxAckPending` / `ackWaitMs` on worker startup so runtime config changes take effect after relaunch.
- A simple limiter controls concurrency in-process.

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
- The NATS adapter updates `attempt` based on redelivery count.
- If `attempt >= maxAttempts` and a `deadLetterQueue` is configured:
    - A dead-letter job is published with the original job and error info.
    - The original message is acked (removed from the stream).

DLQ payload:

- Defined in `indexer/src/domain/dead-letter.ts`.

## Current Job Types

- Sync jobs (`indexer/src/domain/sync-jobs.ts`):
    - `sync.realtime.block`
    - `sync.backfill.range`

`sync.backfill.range` payloads carry explicit origin and order-maintenance
intent:

```ts
type BackfillSyncPayload = {
    fromBlock: number;
    toBlock: number;
    source:
        | "manual_historical"
        | "reorg_recovery"
        | "bootstrap_catchup"
        | "gap_repair";
    orderMaintenancePolicy: "current_state" | "skip_global_maker_revalidation";
};
```

Manual historical backfills use `skip_global_maker_revalidation`, which
preserves raw facts and activity projection while suppressing WETH/counter
maker-wide order revalidation fanout. Reorg recovery, realtime gap repair,
bootstrap catch-up, and realtime processing use `current_state`.

- Reorg jobs (`indexer/src/domain/reorg-jobs.ts`):
    - `reorg.block-check`

- Domain jobs (`indexer/src/domain/domain-jobs.ts`):
- `domain.orders.sync`
- `domain.metadata.sync`
- `domain.activity.sync`

Domain sync payloads also carry an explicit projection contract:

- `projection = facts_only`
    - historical-safe projection only
    - used today for `domain.activity.sync`
- `projection = current_state`
    - may mutate current-state/materialized tables
    - used today for metadata and order-maintenance fanout

This split matters for historical backfill. Pre-anchor ranges are still imported as raw facts, but only anchor-eligible post-anchor windows are allowed to publish current-state work.

- Order update jobs (`indexer/src/domain/order-jobs.ts`):
    - `orders.upsert`
    - `orders.update-by-maker`
    - `orders.update-by-id`

Order update jobs are emitted by the sync worker whenever maker state changes (NFT transfers, NFT approvals, or WETH transfers/approvals when the bidder index is active) or when explicit fill/cancel/on-chain order events are detected. Offchain ingest also emits order update jobs for OpenSea fill/transfer side-effects and explicit order status changes.

`orders.update-by-maker` now uses a scoped payload contract:

- token-scoped updates include `scope = token`, `collectionId`, and `tokenId`
- collection-scoped updates include `scope = collection` and `collectionId`
- global updates include `scope = global` and omit collection/token attribution

- OpenSea jobs (`indexer/src/domain/opensea-jobs.ts`):
    - `opensea.collection.bootstrap`
    - `opensea.collection.reconcile`

- Offchain ingestion jobs (`indexer/src/domain/offchain-jobs.ts`):
    - `offchain.order.raw`

`offchain.order.raw` jobs are produced by the OpenSea stream/bootstrap/reconcile workers and consumed by the offchain ingest worker. These payloads carry:

- `channel` (`stream`, `snapshot`, `reconcile`)
- `eventType`
- optional `orderId`
- optional `runId`
- `receivedAt` (local observation time)
- `sourceEventAt` (source-derived timestamp or `null`)
- raw source payload

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

`bootstrap.collection.start` jobs are produced by future API/UI actions and consumed by the collection bootstrap worker runtime.
`bootstrap.collection.metadata-process` jobs drain durable metadata snapshot tasks from `bootstrap_metadata_snapshot_tasks`.
`bootstrap.collection.ownership-process` jobs drain durable ownership snapshot tasks from `bootstrap_ownership_snapshot_tasks`; ownership terminal failures fail collection bootstrap because ownership is required for liveness.
`bootstrap.collection.image-cache-process` jobs drain durable image-cache tasks from `bootstrap_image_cache_tasks` on the separate `collection-bootstrap-image-cache` queue so slow remote media hosts do not block ownership/backfill/live progress.
`bootstrap.collection.backfill-check` jobs are produced by the bootstrap worker to verify short backfill completion before switching a collection to `live`.

`collection-extension.refresh-artifacts` jobs are produced only after a successful canonical metadata write:

- by `bootstrap-worker` during bootstrap metadata snapshot processing
- by `domain-worker` during `domain.metadata.sync`
- by `domain-worker` during token and range metadata refresh handling

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
    - produced by `bootstrap-worker`
    - consumed by `opensea-bootstrap-worker`
- `opensea.collection.reconcile`
    - produced by `opensea-reconcile-scheduler-worker`
    - consumed by `opensea-reconcile-worker`

Collection extension job production/consumption:

- `collection-extension.refresh-artifacts`
    - produced by `bootstrap-worker` and `domain-worker`
    - consumed by `collection-extension-worker`

These jobs are produced by the scheduler-worker, bootstrap worker, sync worker, domain worker, OpenSea workers, offchain ingest worker, and future API/UI actions, and consumed by the sync, reorg, domain, bootstrap, collection-extension, offchain ingest, and OpenSea runtimes.
