# Bootstrap Execution and Concurrency

This document explains how durable collection-bootstrap steps execute, where
concurrency exists, and which ownership and ordering guarantees a change must
preserve. Bounded concurrency within one step is distinct from distributing
that step's tasks across independently claiming workers.

Values below are the manifest/generated defaults used by typed config loaders when no runtime override is present. Local desktop settings can render different env overrides at launch time.
Pool widths apply to one claimed step's batch, not to aggregate work across
runs, scheduler entry points, or processes.

## Owning Source

- Config manifest: `config/settings.manifest.toml`
- Generated defaults: `shared/config/generated-settings-defaults.ts`
- Indexer config loader: `indexer/src/config/index.ts`
- OpenSea config loader: `indexer/src/config/opensea.ts`
- Bootstrap worker: `indexer/src/runtime/bootstrap-worker.ts`
- Collection-extension worker: `indexer/src/runtime/collection-extension-worker.ts`
- Sync worker: `indexer/src/runtime/sync-worker.ts`
- OpenSea bootstrap worker: `indexer/src/runtime/opensea-bootstrap-worker.ts`
- Queue runtime: `indexer/src/application/worker-runner.ts`, `indexer/src/infra/queue/nats.ts`
- Bootstrap step scheduler: `indexer/src/application/bootstrap-step-scheduler.ts`, `indexer/src/application/bootstrap-step-orchestrator.ts`
- Bootstrap step planner: `backend/src/application/use-cases/bootstrap/bootstrap-pipeline-planner.ts`
- Bootstrap storage adapter: `indexer/src/infra/bootstrap/sqlite.ts`

## Current Configured Values

| Setting                                                 | Current default | Main config surface                                              | Notes                                                              |
| ------------------------------------------------------- | --------------: | ---------------------------------------------------------------- | ------------------------------------------------------------------ |
| `BOOTSTRAP_METADATA_CONCURRENCY`                        |               8 | `IndexerConfig.bootstrap.metadataConcurrency`                    | Local worker-pool width inside the metadata step.                  |
| `BOOTSTRAP_METADATA_BATCH_SIZE`                         |             200 | `IndexerConfig.bootstrap.metadataBatchSize`                      | Due task read/write batch size, not concurrency.                   |
| `BOOTSTRAP_SNAPSHOT_BATCH_SIZE`                         |             200 | `IndexerConfig.bootstrap.snapshotBatchSize`                      | Ownership task seeding and processing batch size, not concurrency. |
| `BOOTSTRAP_IMAGE_CACHE_BATCH_SIZE`                      |              50 | `IndexerConfig.bootstrap.imageCacheBatchSize`                    | Due image-cache task read batch size.                              |
| `BOOTSTRAP_IMAGE_CACHE_CONCURRENCY`                     |               4 | `IndexerConfig.bootstrap.imageCacheConcurrency`                  | Local worker-pool width inside the image-cache step.               |
| `BOOTSTRAP_COLLECTION_EXTENSION_ARTIFACT_CONCURRENCY`   |               2 | `IndexerConfig.bootstrap.collectionExtensionArtifactConcurrency` | Queue max-in-flight for collection-extension artifact jobs.        |
| `BOOTSTRAP_COLLECTION_EXTENSION_ARTIFACT_TASK_LEASE_MS` |           60000 | `IndexerConfig.bootstrap.collectionExtensionArtifactTaskLeaseMs` | Per artifact task lease duration.                                  |
| `BACKFILL_BATCH_SIZE`                                   |              10 | `IndexerConfig.sync.backfillBatchSize`                           | Bootstrap catchup range chunk size.                                |
| `BACKFILL_WORKER_COUNT`                                 |               1 | `IndexerConfig.sync.backfillWorkerCount`                         | Backfill sync queue max-in-flight.                                 |

There is no dedicated OpenSea bootstrap concurrency setting. The OpenSea bootstrap worker currently subscribes with `maxInFlight: 1`.

## Shared Concurrency Primitives

Queue workers use NATS JetStream durable consumers. `runWorker` forwards each worker's `maxInFlight` into the queue adapter, and the NATS adapter enforces it both as `maxAckPending` on the durable consumer and as an in-process limiter.

The bootstrap worker also runs two durable step scheduler lanes:

- main lane: anchor, enumeration, metadata, ownership, backfill, collection live, collection-extension artifact step coordination, and OpenSea step coordination
- image-cache lane: image-cache step only

Each lane's poller prevents overlap between its own timer callbacks. Queue
handlers can enter the same lane independently, so there is no process-wide
one-call-at-a-time lane lock. Each scheduler invocation visits due run ids
serially, then the orchestrator claims ready steps
using persisted step leases. `BOOTSTRAP_STEP_CLAIM_LIMIT` is currently `1`, so
a lane claims at most one step per run iteration. Step leases are renewed while
the processor runs, and lease release is fenced by owner. Generic progress and
terminal-settlement writes do not carry that owner predicate.

This coordinates the normal duplicate-delivery and repeated-poll path through
the durable step row, but it is not a complete stale-owner settlement fence.

## Pipeline Steps

### 1. Register Collection / Create Run

Current concurrency setting: no dedicated knob.

Typed runtime config: no.

Current model:

- Backend use case validates the request, resolves embedded extension eligibility, upserts the collection, checks for an active run, creates a bootstrap run plus planned steps, then publishes one `bootstrap.collection.start` job.
- The application check rejects an already-active run. The database partial
  unique index also rejects concurrent `requested`, `queued`, `metadata`,
  `ownership`, or `backfill` rows for one collection, but it does not include
  the later-added `image_cache` run status.
- The queue publish uses a start scope plus timestamp. JetStream deduplicates
  only an exactly reused generated job id; a fresh publication gets a fresh id.
  Run creation and queue publication are not one transactional boundary.

Scaling boundary:

- No throughput setting is needed for normal registration. User-triggered run creation is not a heavy pipeline stage.
- If this path needs stronger crash recovery, the clean improvement is a transactional queue outbox for bootstrap start publication, not higher concurrency. The backend would commit run creation and outbox intent together, and a publisher would drain the outbox idempotently.
- If many collections are registered at once, concurrency should be governed by durable run and step leases downstream, not by allowing multiple active runs for one collection.

### 2. Pick Anchor Block

Current concurrency setting: serial per scheduler invocation, not a global lane cap.

Typed runtime config: no.

Current model:

- The bootstrap worker consumes the `collection-bootstrap` queue with `maxInFlight: 1`.
- Each main-scheduler invocation claims at most one ready step per run
  iteration; timer and queue-triggered invocations can overlap.
- Anchor work reads current head, subtracts reorg depth, persists the anchor block/hash/timestamp, and marks the step terminal.
- Embedded extension installation runs immediately after successful anchoring when the run requested an embedded extension.

Scaling boundary:

- Deliberate multi-run scaling needs a bounded lane-concurrency policy covering
  both timer and queue entry points. Keep run state isolated and preserve
  per-step ownership, including stale-owner fencing, rather than assuming
  `maxInFlight: 1` also serializes the poller.
- No per-token or batch taskization is useful for anchoring itself.

### 3. Auto-Install Embedded Collection Extension

Current concurrency setting: coupled to each claimed anchor step.

Typed runtime config: no.

Current model:

- Request-time planning stores the requested extension key when collection contract plus token scope matches an embedded extension.
- Anchor success calls the extension install upsert for that collection.
- The install must exist before the later collection-extension step seeds and
  publishes artifact refresh work from the settled metadata snapshot.

Scaling boundary:

- Keep this coupled to the anchored step. It is a small idempotent DB action and is semantically part of starting the run against a concrete collection id.
- Repeating the same install is an idempotent upsert. Multi-run execution must
  also prevent a stale processor from replacing a newer collection install;
  the presence of a step lease alone does not prove that fence.

### 4. Token Enumeration

Current concurrency setting: serial within one claimed enumeration step.

Typed runtime config: no.

Current model:

- Enumerable runs call `totalSupply`, then call `tokenByIndex` sequentially from index `0` to `totalSupply - 1`.
- Manual token-id and manual-range runs resolve locally.
- Enumeration stores progress on the durable step and logs heartbeat progress.
- The implementation builds the token id list in memory before seeding metadata tasks.

Scaling boundary:

- The cleanest scalability upgrade is durable page/task enumeration:
    - create enumeration page tasks with cursor/index ranges,
    - claim pages with leases,
    - write discovered token ids into a staging table with unique constraints,
    - seed metadata tasks after all pages are terminal,
    - keep run progress derived from persisted page/task counts.
- A lighter local-only worker pool around `tokenByIndex` could reduce latency, but it is weaker because progress, retries, and crash recovery still depend on one long-running step. That is acceptable only if deliberately scoped as an optimization, not as the durable concurrency model.
- For large collections, a streamed approach would also avoid building the full token id array in memory. Token ids could be inserted into metadata tasks as pages complete, with completion determined by page task terminality.

### 5. Metadata Task Seeding

Current concurrency setting: no concurrency. Batch size is `BOOTSTRAP_METADATA_BATCH_SIZE=200`.

Typed runtime config: yes, as batch size.

Current model:

- After enumeration, metadata task seeding writes `bootstrap_metadata_snapshot_tasks` in batches.
- `BOOTSTRAP_METADATA_BATCH_SIZE` controls insert batch size, not parallelism.
- The executor marks enumeration succeeded before it inserts metadata task
  batches.
- If the enumeration executor itself is re-entered and any metadata tasks
  already exist, it skips seeding and treats that count as the token count.

Scaling boundary:

- Do not add write concurrency first. SQLite benefits more from bounded transaction shape than concurrent writers.
- If enumeration becomes page/task based, metadata task seeding can happen page-by-page in the same page task transaction, with unique `(run_id, token_id)` conflict handling.
- For clean recovery, the completion condition should be persisted page terminality plus task counts, not in-memory counters.
- Current recovery does not prove full seeding after a process exit between
  enumeration success and the last metadata task batch. That transition needs a
  persisted expected count or an atomic/page-terminal boundary before it can be
  described as crash-safe.

### 6. Metadata Fetch / Store

Current concurrency setting: `BOOTSTRAP_METADATA_CONCURRENCY=8`.

Typed runtime config: yes.

Current model:

- The metadata step is one leased bootstrap step.
- Each pass reads up to `BOOTSTRAP_METADATA_BATCH_SIZE` due metadata tasks.
- The step processes the due tasks through an in-process bounded worker pool with width `BOOTSTRAP_METADATA_CONCURRENCY`.
- Each token calls the metadata domain refresh path, which transactionally
  stores canonical `tokens`, `token_metadata`, and normalized attributes.
- Once task counts satisfy the metadata snapshot mode, bootstrap records the
  early canonical stats follow-up and queue-outbox intent before marking the
  metadata step succeeded. The later collection-extension step owns artifact
  task seeding.
- Failed tasks are moved to retry or terminal failure according to the bootstrap metadata retry policy and snapshot mode.
- Completion is derived from persisted metadata task counts.

Scaling boundary:

- The local pool selects one due batch inside the owning metadata step. The
  step lease is intended to exclude another processor for that run; it does not
  fence every write after lease expiry (see `BKL-063`).
- Processing different runs concurrently can retain step-level ownership.
  Splitting one run's due tasks across independent workers needs exclusive
  task claims and fenced writes/settlement, or an equivalent ownership design.
- More queue consumers are not a substitute for that design: local
  `mapWithConcurrency` bounds one processor's batch, not overlapping processors
  after a lost lease.

### 7. Token Image Cache Side Lane

Current concurrency setting: `BOOTSTRAP_IMAGE_CACHE_CONCURRENCY=4`.

Typed runtime config: yes.

Current model:

- The image-cache step is a non-blocking side lane that depends on metadata.
- The bootstrap worker has a separate `collection-bootstrap-image-cache` queue consumer, but it is subscribed with `maxInFlight: 1`.
- The image-cache lane claims one image-cache step with a persisted step lease.
- Each pass reads up to `BOOTSTRAP_IMAGE_CACHE_BATCH_SIZE=50` due image-cache tasks.
- The due batch is processed through an in-process bounded worker pool with width `BOOTSTRAP_IMAGE_CACHE_CONCURRENCY`.
- Success writes the settled `token_image_cache` row transactionally with task success. If the task settlement loses the race, the newly written file is deleted.
- Image cache failures can become terminal without failing collection liveness.

Scaling boundary:

- The local pool is coordinated by the image-cache step lease, with the same
  stale-step-owner limitation as metadata.
- Tasks are not individually claimed before external fetch/resize work. To
  distribute one run's tasks, introduce exclusive task ownership and fenced
  success/retry writes; collection-extension task lifecycle is one existing
  model to evaluate. Different runs need not share a task pool.

### 8. Collection-Extension Artifacts

Current concurrency setting: `BOOTSTRAP_COLLECTION_EXTENSION_ARTIFACT_CONCURRENCY=2`.

Typed runtime config: yes.

Current model:

- Metadata completion makes the collection-extension artifact step ready when the run has an embedded extension.
- The main bootstrap lane seeds metadata-derived artifact tasks and extension-owned artifact tasks in one SQLite transaction.
- For Terraforms, extension-owned tasks include synthetic unminted-placement artifact tasks.
- The main lane publishes due artifact tasks to the dedicated `collection-extension-artifacts` queue.
- The collection-extension worker subscribes with `maxInFlight` equal to `BOOTSTRAP_COLLECTION_EXTENSION_ARTIFACT_CONCURRENCY`.
- Each bootstrap artifact task has `lease_owner` and `lease_until`.
- Workers claim pending/retry tasks with a persisted lease, renew that lease
  while rendering/fetching, and only the current lease owner can settle success,
  retry, or terminal failure.
- Extension artifact and trait writes happen before that fenced task settlement;
  the writes are not themselves conditioned on the lease owner.
- Completion and final stats release are derived from persisted artifact task counts.
- Synthetic Terraforms rows are published atomically with their extension artifact and trait writes, and synthetic identities are tombstoned when retired so delayed bootstrap tasks cannot recreate them after a real mint refresh.

Scaling boundary:

- This is the strongest concurrency model in the bootstrap pipeline today.
- Increasing `BOOTSTRAP_COLLECTION_EXTENSION_ARTIFACT_CONCURRENCY` remains
  bounded by RPC capacity, renderer cost, HTTP fetch rate, and SQLite write
  pressure.
- Before increasing worker count across processes, prove extension writes are
  idempotent and current, or bring those writes under the same lease fence as
  task settlement.

### 9. Ownership Snapshot

Current concurrency setting: serial within one claimed ownership step.

Typed runtime config: no. `BOOTSTRAP_SNAPSHOT_BATCH_SIZE=200` is only a batch size.

Current model:

- The ownership step depends on metadata.
- Ownership tasks are seeded from metadata task token ids.
- Each pass reads up to `BOOTSTRAP_SNAPSHOT_BATCH_SIZE` due ownership tasks.
- Tasks are processed serially. Each task calls `ownerOf(tokenId)` at the anchor block.
- Success writes a snapshot row and marks the ownership task succeeded in a transaction.
- Once all ownership tasks succeed, `finalizeSnapshot` projects the snapshot into current ownership state at the anchor block.
- Ownership is mandatory: terminal ownership task failures fail the bootstrap run and block collection liveness.

Scaling boundary:

- A bounded in-step pool could parallelize independent `ownerOf` reads from one
  selected batch, as metadata already does. It would still rely on step-level
  ownership, need a typed concurrency setting, and need tests for retries,
  pause/resume, stale processors, and crash recovery. Per-task leases are not
  an inherent requirement of local parallel reads.
- Distributing one run's ownership tasks across independent workers is a
  separate design: add exclusive task claims, lease renewal, and fenced
  snapshot/task writes and settlement, or an equivalent ownership mechanism.
- Snapshot finalization must remain a single transaction after all required
  ownership tasks **succeed**, not merely become terminal. A terminal failure
  still blocks liveness. Neither scaling approach may finalize a partial
  snapshot or allow a stale step owner to overwrite newer state.

### 10. Short Backfill

Current concurrency setting: `BACKFILL_WORKER_COUNT=1`.

Typed runtime config: yes, under sync config rather than bootstrap config.

Current model:

- The bootstrap backfill step schedules collection-scoped current-state catchup ranges from `anchor + 1` to current head.
- Range size is `BACKFILL_BATCH_SIZE=10`.
- Jobs go to the shared `events-sync-backfill` queue.
- The sync worker subscribes with `maxInFlight` equal to `BACKFILL_WORKER_COUNT`.
- `BackfillExecutionGate` allows fully pre-anchor facts-only ranges to run in
  parallel and serializes current-state-capable ranges within one sync-worker
  process, in the order they enter that gate.
- Bootstrap catchup is post-anchor and uses current-state order maintenance.
  The gate does not sort by block number, coordinate other worker processes,
  or prevent an earlier retried range from arriving after a later range.
  Serialization is not proof of chronological apply order.

Scaling boundary:

- Raising `BACKFILL_WORKER_COUNT` allows overlapping pre-anchor facts-only
  imports within the process. It does not parallelize that process's
  current-state gate or establish cross-process ordering. Check resource
  pressure and retry/idempotency behavior for the intended workload.
- Clean current-state backfill parallelism needs a fetch/apply split:
    - fetch logs/blocks in parallel for ranges,
    - persist raw/fact data idempotently,
    - apply current-state projections through an ordered per-collection barrier by block/log order,
    - commit coverage only after ordered apply completes.
- Another clean option is per-collection current-state lanes where independent collections can apply in parallel, but any shared contract/order side effects must be proven collection-scoped first.
- Do not bypass `BackfillExecutionGate` just to make bootstrap faster. That would weaken ownership/order projection correctness.

### 11. Collection Live

Current concurrency setting: serial per scheduler invocation, not a global lane cap.

Typed runtime config: no.

Current model:

- The collection-live step depends on backfill.
- It reads the backfill live block from step result, marks the collection bootstrap finished, marks the run completed, and cleans successful temporary data.
- For runs without collection extensions, it records the final stats follow-up
  and queue-outbox intent during collection-live processing.
- For runs with collection extensions, extension artifact terminality records
  that final follow-up instead, so extension-owned traits are included.

Scaling boundary:

- No dedicated concurrency is needed. This is a small finalization step.
- Collection-live uses its step lease and collection/run checks, with the
  stale-owner write limitation described below. Do not treat this as a complete
  finalization fence when changing concurrency.
- If this multi-call finalization is hardened later, the important boundary is
  one transaction after backfill coverage, not higher throughput.

### 12. OpenSea Bootstrap

Current concurrency setting: 1.

Typed runtime config: no. The OpenSea runtime has page size, retry, stale-start, subscription poll, and rate-limit settings, but no bootstrap concurrency setting.

Current model:

- Bootstrap plans OpenSea side-lane steps only when OpenSea integration is enabled and an explicit slug exists.
- After metadata and ownership, bootstrap schedules one OpenSea bootstrap job.
- The OpenSea bootstrap worker subscribes with `maxInFlight: 1`.
- The worker marks identity running/succeeded, snapshot running, then calls `OpenSeaOrderbookSync.syncCollection`.
- The orderbook sync paginates listings serially, then offers serially.
- Each REST record is published to the offchain raw queue.
- When the REST snapshot completes, the source-state store marks missing orders
  inactive for the run's active order id set, the collection OpenSea state is
  marked ready, and the source run is completed.

Scaling boundary:

- A dedicated `OPENSEA_BOOTSTRAP_CONCURRENCY` setting could be added, but only with per-collection snapshot ownership guarantees.
- Clean requirements:
    - prevent two OpenSea snapshot runs for the same collection from concurrently marking missing orders inactive,
    - fence work by latest bootstrap/reconcile run id,
    - share API rate limiting across concurrent snapshots,
    - keep OpenSea bootstrap step terminality tied to the correct run,
    - preserve idempotent raw observation dedupe keys.
- Page-level parallelism is not obviously clean because pagination cursors are sequential. The safe first concurrency boundary is collection-level, not page-level.

### 13. Metadata Stats Follow-Ups

Current concurrency setting: effectively 1 in the domain worker.

Typed runtime config: no.

Current model:

- Metadata task completion records an early canonical stats follow-up and outbox
  job.
- Collection-extension artifact terminality records final stats follow-up and
  outbox work for extension collections.
- Non-extension collection-live processing records the final follow-up itself.
- The domain worker subscribes to the metadata-stats queue with
  `maxInFlight: 1`.

Scaling boundary:

- If stats recompute becomes expensive, add per-collection stats leases or versioned recompute rows before raising worker concurrency.
- Independent collections can have separate recompute ownership. Overlapping
  recomputes for the same collection need serialization or a currentness fence
  so an older calculation cannot replace newer statistics.

## Current Concurrency Model

The pipeline already has three different concurrency tiers:

1. Durable step leases for bootstrap phase orchestration.
2. Local bounded worker pools for metadata and image cache task batches.
3. Durable per-task leases for collection-extension artifacts.

Collection-extension artifact task claims and settlement are leased, but their
data writes precede the settlement fence. Metadata and image cache use local
pools under a step lease; ownership currently uses a serial loop under that
same kind of lease. These are implemented mechanisms, not proof that stale
processors or arbitrary additional workers are safe.

Choose the next optimization from measurements. A bounded ownership pool can
reduce serial RPC latency; persisted enumeration pages can improve restart
behavior and memory use. Neither requires treating independently distributed
task workers as the only acceptable design.

## Current Limits and Future Direction

- Ownership reads are serial. Measure their share of bootstrap time before
  choosing a bounded in-step pool or independently leased task workers.
- Enumerable discovery is one long-running step. Persisted enumeration page
  tasks would improve crash recovery and avoid retaining the full token list in
  memory before metadata seeding.
- Enumeration terminality currently precedes completion of batched metadata task
  seeding. Persist an expected count or couple terminality to verified seeding
  so restart cannot accept an empty or partial task set as complete.
- Step lease renewal and release are owner-fenced, but generic progress and
  terminal-settlement writes are not. A processor that outlives its lease can
  still update the step row, so those writes need the active lease owner or an
  equivalent generation fence.
- Metadata and image caching are bounded local pools, not independently claimed
  task pools. Scaling must preserve per-run step ownership or introduce
  exclusive ownership of individual tasks, including stale-owner fencing.
- The active-run partial unique index does not include `image_cache`; the
  application-level check covers the normal path, but the database invariant
  should be extended to cover every active run status.
- OpenSea bootstrap is serialized at the collection snapshot boundary. Safe
  collection-level concurrency must fence missing-order reconciliation by the
  owning run and share API rate limits.
- Collection-extension task settlement is fenced, but artifact and trait writes
  occur first. Multi-process scaling needs idempotency/currentness proof or a
  fenced write boundary.
- Current-state catch-up is serialized within one process, not ordered by a
  durable block-range barrier. Retry and multi-process ordering remain concerns;
  parallel fetch/apply work must preserve projection currentness explicitly.

The [unified backlog](../planning/01-unified-backlog.md) owns priority for these
directions; this document owns the invariants any implementation must preserve.
