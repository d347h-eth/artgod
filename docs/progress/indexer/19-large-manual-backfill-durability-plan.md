# Large Manual Backfill Durability Plan

Status: proposed.

## Context

The blockspace page can schedule manual backfills over arbitrary block ranges.
With the current default `BACKFILL_BATCH_SIZE=50`, a 4-year Ethereum range of
`11,520,758` blocks would fan out to:

```text
ceil(11,520,758 / 50) = 230,416 sync.backfill.range jobs
```

Current manual scheduling is direct queue fan-out:

- `backend/src/application/use-cases/sync-backfill/schedule-sync-backfill.ts`
  builds every range command in memory for the submitted request.
- `backend/src/infra/sync-backfill/nats-sync-backfill-command-queue.ts`
  opens a NATS connection for that request and publishes each command one by
  one with `await js.publish(...)`.
- The JetStream stream is file-backed Workqueue retention with 7-day max age.
- The sync worker consumes backfill with conservative in-order processing
  (`maxInFlight = 1` today).

NATS JetStream can likely hold hundreds of thousands of small messages when
disk and stream limits are healthy, but the current application workflow should
not rely on publishing a massive queue from one HTTP request as the durable
source of truth.

## Current Risk

- The HTTP request must stay alive until every message has been published.
- A mid-publish failure leaves an unknown prefix of jobs queued.
- Manual job ids include a per-submission nonce, so retrying the same request
  creates a new duplicate job set instead of resuming idempotently.
- Queue backlog is bounded by stream configuration and max age, not by an
  application-level run model.
- The backfill worker is intentionally serial today, so very large ranges can
  sit in the stream for a long time.
- Small 50-block jobs create high fan-out and extra queue overhead for huge
  historical ranges.
- Each backfill range still fetches per-block header data after log fetching,
  so total RPC work can dominate queue costs for multi-year ranges.

## Design Goal

Make manual blockspace backfill durable for ranges of any practical size:

- the user request records intent quickly
- progress survives backend, NATS, and worker restarts
- publishing can resume after partial failure
- NATS is used for delivery and wake-up, not as the authoritative run state
- queue depth is bounded by policy
- throughput can stay conservative without risking silent loss

Great performance is a secondary goal. The first goal is that a very large run
eventually crunches through or lands in an explicit failed/cancelled state.

## Proposed Shape

### 1. Persist Backfill Runs

Add tables owned by the backend/indexer boundary, for example:

- `blockspace_backfill_runs`
    - `id`
    - `chain_id`
    - `collection_id` nullable for chain-wide runs
    - `from_block`
    - `to_block`
    - `batch_size`
    - `status`
    - `next_publish_from_block`
    - `completed_block`
    - `queued_jobs`
    - `completed_jobs`
    - `failed_jobs`
    - `created_at`
    - `updated_at`
    - `completed_at`
    - `cancelled_at`
    - `last_error`
- `blockspace_backfill_run_jobs`
    - `run_id`
    - `from_block`
    - `to_block`
    - `status`
    - `attempts`
    - `published_at`
    - `started_at`
    - `completed_at`
    - `last_error`

The exact schema can be smaller in the first pass, but the run record should be
the recovery source. Do not make the NATS stream the only record of a scheduled
manual range.

### 2. Publish A Bounded Window

Replace direct full-range fan-out with a feeder:

- API creates a `queued` run in SQLite.
- A backend or indexer feeder publishes only a bounded number of pending jobs,
  such as 500, 1,000, or 5,000 jobs ahead.
- As jobs complete, the feeder advances the run cursor and publishes more.
- Queue-depth limits should be config-driven and visible in status output.

This keeps NATS pressure bounded while still allowing arbitrary logical run
size.

### 3. Use Deterministic Job IDs

Manual backfill jobs should be idempotent across publish retries:

```text
sync:manual:<run_id>:<from_block>-<to_block>
```

Avoid per-submission nonce values for persisted runs. If the same run window is
republished after a crash, JetStream `msgID` dedupe and the run-job table should
make that retry harmless.

### 4. Treat NATS As Delivery, Not Truth

Follow the same durable pattern used by DB-backed trading jobs:

- commit the run/job state first
- publish JetStream wake-up or work messages after commit
- periodically scan SQLite for pending work so missed publishes recover

The broker should speed up processing. SQLite should answer what still needs to
happen.

### 5. Revisit Granularity For Huge Historical Runs

For very large historical ranges, the default `BACKFILL_BATCH_SIZE=50` is too
fine for queue fan-out.

Consider separating logical scheduling from execution chunking:

- Use larger queued jobs for historical backfill, for example 1,024, 2,000, or
  4,096 blocks.
- Keep RPC log chunking inside the RPC adapter (`LOG_CHUNK_SIZE`) so provider
  limits are still respected.
- Keep current-state and post-anchor ownership writes conservative.
- Later, optimize block timestamp/header reads so dense backfill does not make
  one independent block RPC call per block.

The first implementation can keep a single configured batch size if that is
simpler, but massive-run UX should show the estimated job count before commit.

## Implementation Slices

### Slice 1: Operator Safety

- Add a schedule-size warning or confirmation threshold in the blockspace UI.
- Add backend validation that refuses or explicitly requires confirmation above
  a configured estimated job count.
- Keep existing direct fan-out while preventing accidental 100k+ job schedules.

### Slice 2: Persistent Run Model

- Add migrations for run and run-job state.
- Change the scheduling use case to create a run instead of publishing every
  range immediately.
- Return run id and estimated totals from the API.

### Slice 3: Feeder And Idempotent Publish

- Add a feeder use case that publishes the next bounded window from SQLite.
- Use deterministic job ids derived from run id and block range.
- Add periodic recovery scan so a missed publish does not stall the run.

### Slice 4: Worker Completion Accounting

- Mark run jobs started/completed/failed from the sync worker.
- Advance run progress from durable completion state.
- Support pause, cancel, resume, and retry-failed controls.

### Slice 5: Throughput Tuning

- Add separate config for manual historical job size if needed.
- Add explicit queue-depth/backpressure metrics.
- Revisit safe parallelism only for facts-only historical ranges.
- Optimize dense block header/timestamp fetching before raising concurrency.

## Open Questions

- Should the feeder live in backend, indexer, or a dedicated runtime?
- Should manual backfill run state be collection-scoped only, chain-wide only,
  or both from the start?
- What is the first safe queue window size for desktop defaults?
- Should 7-day JetStream max age remain unchanged once run state is durable?
- Should public/read-only deployments expose run status but hide all mutation
  endpoints?

## Non-Goals For First Pass

- Full automatic performance tuning.
- Parallel post-anchor current-state mutation.
- Replacing JetStream.
- Guaranteeing fast completion on public RPC providers.
