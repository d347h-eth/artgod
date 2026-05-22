# Blueprint Gaps: Job Queueing and Async Workflows

This file lists items described in `docs/blueprint/04-job-queueing.md` that are not fully implemented yet.

## Queue Categories Not Implemented

- `orderbook-orders-queue`
- `opensea-listings-queue`
- `token-updates-mint-queue`
- `metadata-index-fetch` / `metadata-index-write` split queues
- `collection-updates-recalc-owner-count`
- Analytics or Elasticsearch queues (for activity indexing)

## Retry and Delay Strategies

- No explicit exponential backoff schedule for retries.
- Retries currently rely on JetStream redelivery rather than a configurable backoff policy.

## Batch Consumption Patterns

- No dedicated batch consumption for throughput (workers process messages individually with a limiter).

## Manual Backfill Fan-Out Durability

- Manual blockspace backfill scheduling currently publishes every derived range
  job directly to NATS from one backend request.
- Very large ranges can produce hundreds of thousands of `sync.backfill.range`
  jobs with the current default `BACKFILL_BATCH_SIZE=50`.
- There is no persisted run/cursor model that can resume after partial publish
  failure.
- See `docs/progress/indexer/19-large-manual-backfill-durability-plan.md` for
  the proposed DB-backed run model and bounded JetStream feeder.

## Job-Level Dedup Beyond Sync

- Sync jobs use jobId for dedupe, but there are no explicit dedupe keys for metadata or order update jobs beyond jobId naming.
