# Blueprint Gaps: Job Queueing and Async Workflows

This file lists items described in `docs/blueprint/04-job-queueing.md` that are not fully implemented yet.

## Queue Categories Not Implemented

- `order-updates-by-maker`
- `order-updates-by-id`
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

## Job-Level Dedup Beyond Sync

- Sync jobs use jobId for dedupe, but there are no explicit dedupe keys for metadata or order update jobs beyond jobId naming.
