# Queues and Jobs

This document covers the queue contract, job envelopes, and the NATS JetStream adapter used for durable job delivery.

## Queue Names

Queue names are defined in `indexer/src/domain/queues.ts`:

- `events-sync-realtime`
- `events-sync-backfill`
- `block-check`
- `collection-bootstrap`
- `offchain-orders-raw`
- `orders-domain`
- `orders-upsert`
- `order-updates-by-maker`
- `order-updates-by-id`
- `metadata-domain`
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
  collectionId?: string;
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
- A simple limiter controls concurrency in-process.

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

- Reorg jobs (`indexer/src/domain/reorg-jobs.ts`):
    - `reorg.block-check`

- Domain jobs (`indexer/src/domain/domain-jobs.ts`):
    - `domain.orders.sync`
    - `domain.metadata.sync`
    - `domain.activity.sync`

- Order update jobs (`indexer/src/domain/order-jobs.ts`):
    - `orders.upsert`
    - `orders.update-by-maker`
    - `orders.update-by-id`

Order update jobs are emitted by the sync worker whenever maker state changes (NFT transfers or WETH transfers/approvals when the bidder index is active) or when explicit fill/cancel/on-chain order events are detected. Offchain ingest also emits order update jobs for OpenSea fill/transfer side-effects and explicit order status changes.

- Offchain ingestion jobs (`indexer/src/domain/offchain-jobs.ts`):
    - `offchain.order.raw`

`offchain.order.raw` jobs are produced by the OpenSea stream/bootstrap/reconcile workers and consumed by the offchain ingest worker.

- Bootstrap jobs (`indexer/src/domain/bootstrap-jobs.ts`):
    - `bootstrap.collection.start`
    - `bootstrap.collection.backfill-check`

`bootstrap.collection.start` jobs are produced by future API/UI actions and consumed by the collection bootstrap worker runtime.
`bootstrap.collection.backfill-check` jobs are produced by the bootstrap worker to verify short backfill completion before switching a collection to `live`.

These jobs are produced by the scheduler-worker, sync worker, offchain ingest/stream workers, and future API/UI actions, and consumed by the sync, reorg, domain, offchain ingest, and bootstrap runtimes.
