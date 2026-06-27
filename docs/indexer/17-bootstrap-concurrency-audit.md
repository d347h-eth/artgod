# Bootstrap Concurrency Audit

This document captures the current collection bootstrap concurrency model and the clean upgrade paths for steps that are still serial. It is an implementation snapshot, not a proposal to increase concurrency everywhere.

Values below are the manifest/generated defaults used by typed config loaders when no runtime override is present. Local desktop settings can render different env overrides at launch time.

## Source Map

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

| Setting | Current default | Main config surface | Notes |
| --- | ---: | --- | --- |
| `BOOTSTRAP_METADATA_CONCURRENCY` | 8 | `IndexerConfig.bootstrap.metadataConcurrency` | Local worker-pool width inside the metadata step. |
| `BOOTSTRAP_METADATA_BATCH_SIZE` | 200 | `IndexerConfig.bootstrap.metadataBatchSize` | Due task read/write batch size, not concurrency. |
| `BOOTSTRAP_SNAPSHOT_BATCH_SIZE` | 200 | `IndexerConfig.bootstrap.snapshotBatchSize` | Ownership task seeding and processing batch size, not concurrency. |
| `BOOTSTRAP_IMAGE_CACHE_BATCH_SIZE` | 50 | `IndexerConfig.bootstrap.imageCacheBatchSize` | Due image-cache task read batch size. |
| `BOOTSTRAP_IMAGE_CACHE_CONCURRENCY` | 4 | `IndexerConfig.bootstrap.imageCacheConcurrency` | Local worker-pool width inside the image-cache step. |
| `BOOTSTRAP_COLLECTION_EXTENSION_ARTIFACT_CONCURRENCY` | 2 | `IndexerConfig.bootstrap.collectionExtensionArtifactConcurrency` | Queue max-in-flight for collection-extension artifact jobs. |
| `BOOTSTRAP_COLLECTION_EXTENSION_ARTIFACT_TASK_LEASE_MS` | 60000 | `IndexerConfig.bootstrap.collectionExtensionArtifactTaskLeaseMs` | Per artifact task lease duration. |
| `BACKFILL_BATCH_SIZE` | 10 | `IndexerConfig.sync.backfillBatchSize` | Bootstrap catchup range chunk size. |
| `BACKFILL_WORKER_COUNT` | 1 | `IndexerConfig.sync.backfillWorkerCount` | Backfill sync queue max-in-flight. |

There is no dedicated OpenSea bootstrap concurrency setting. The OpenSea bootstrap worker currently subscribes with `maxInFlight: 1`.

## Shared Concurrency Primitives

Queue workers use NATS JetStream durable consumers. `runWorker` forwards each worker's `maxInFlight` into the queue adapter, and the NATS adapter enforces it both as `maxAckPending` on the durable consumer and as an in-process limiter.

The bootstrap worker also runs two durable step scheduler lanes:

- main lane: anchor, enumeration, metadata, ownership, backfill, collection live, collection-extension artifact step coordination, and OpenSea step coordination
- image-cache lane: image-cache step only

Each lane has a poller that prevents overlapping polls inside the same process. The scheduler collects due run ids, then the orchestrator claims ready steps using persisted step leases. `BOOTSTRAP_STEP_CLAIM_LIMIT` is currently `1`, so a lane claims at most one step per run iteration. Step leases are renewed while the processor runs, and release/settlement is fenced by lease owner.

This gives one important property: even when queue jobs are duplicated or scheduler polls wake the same run more than once, the durable step row remains the step-level concurrency boundary.

## Pipeline Steps

### 1. Register Collection / Create Run

Current concurrency setting: no dedicated knob.

Bubbled into main config: no.

Current model:

- Backend use case validates the request, resolves embedded extension eligibility, upserts the collection, checks for an active run, creates a bootstrap run plus planned steps, then publishes one `bootstrap.collection.start` job.
- The active-run guard prevents concurrent bootstrap runs for the same collection.
- The queue publish uses a deterministic-ish start scope plus timestamp. It is idempotent at the NATS message id level for the generated job id, but run creation and queue publication are not a general multi-message work pool.

Clean concurrency options:

- No throughput setting is needed for normal registration. User-triggered run creation is not a heavy pipeline stage.
- If this path needs stronger crash recovery, the clean improvement is a transactional queue outbox for bootstrap start publication, not higher concurrency. The backend would commit run creation and outbox intent together, and a publisher would drain the outbox idempotently.
- If many collections are registered at once, concurrency should be governed by durable run and step leases downstream, not by allowing multiple active runs for one collection.

ASAP risk: no merge blocker found.

### 2. Pick Anchor Block

Current concurrency setting: effectively 1.

Bubbled into main config: no.

Current model:

- The bootstrap worker consumes the `collection-bootstrap` queue with `maxInFlight: 1`.
- The main scheduler lane claims one ready step at a time.
- Anchor work reads current head, subtracts reorg depth, persists the anchor block/hash/timestamp, and marks the step terminal.
- Embedded extension installation runs immediately after successful anchoring when the run requested an embedded extension.

Clean concurrency options:

- Across different runs, this could be parallelized by introducing a main-lane concurrency setting and allowing the scheduler to process multiple run ids concurrently.
- The clean design requires preserving per-run step leases and ensuring the processor receives isolated run state. The existing step lease model is close, but the runtime would need an explicit lane-concurrency contract rather than ad hoc parallel `runOnce` calls.
- No per-token or batch taskization is useful for anchoring itself.

ASAP risk: no merge blocker found.

### 3. Auto-Install Embedded Collection Extension

Current concurrency setting: effectively 1, coupled to anchor.

Bubbled into main config: no.

Current model:

- Request-time planning stores the requested extension key when collection contract plus token scope matches an embedded extension.
- Anchor success calls the extension install upsert for that collection.
- The install must exist before canonical metadata writes can fan out extension artifact refresh work.

Clean concurrency options:

- Keep this coupled to the anchored step. It is a small idempotent DB action and is semantically part of starting the run against a concrete collection id.
- If main-lane concurrency is added later, the install remains safe as a per-run/per-collection upsert behind the anchor step lease.

ASAP risk: no merge blocker found.

### 4. Token Enumeration

Current concurrency setting: 1.

Bubbled into main config: no.

Current model:

- Enumerable runs call `totalSupply`, then call `tokenByIndex` sequentially from index `0` to `totalSupply - 1`.
- Manual token-id and manual-range runs resolve locally.
- Enumeration stores progress on the durable step and logs heartbeat progress.
- The implementation builds the token id list in memory before seeding metadata tasks.

Clean concurrency options:

- The cleanest scalability upgrade is durable page/task enumeration:
  - create enumeration page tasks with cursor/index ranges,
  - claim pages with leases,
  - write discovered token ids into a staging table with unique constraints,
  - seed metadata tasks after all pages are terminal,
  - keep run progress derived from persisted page/task counts.
- A lighter local-only worker pool around `tokenByIndex` could reduce latency, but it is weaker because progress, retries, and crash recovery still depend on one long-running step. That is acceptable only if deliberately scoped as an optimization, not as the durable concurrency model.
- For large collections, a streamed approach would also avoid building the full token id array in memory. Token ids could be inserted into metadata tasks as pages complete, with completion determined by page task terminality.

ASAP risk: no merge blocker found for current target collections. This is a future scalability concern.

### 5. Metadata Task Seeding

Current concurrency setting: no concurrency. Batch size is `BOOTSTRAP_METADATA_BATCH_SIZE=200`.

Bubbled into main config: yes, as batch size.

Current model:

- After enumeration, metadata task seeding writes `bootstrap_metadata_snapshot_tasks` in batches.
- `BOOTSTRAP_METADATA_BATCH_SIZE` controls insert batch size, not parallelism.
- Existing task counts make seeding idempotent on resume: if metadata tasks already exist, seeding is skipped and the metadata step is considered queued.

Clean concurrency options:

- Do not add write concurrency first. SQLite benefits more from bounded transaction shape than concurrent writers.
- If enumeration becomes page/task based, metadata task seeding can happen page-by-page in the same page task transaction, with unique `(run_id, token_id)` conflict handling.
- For clean recovery, the completion condition should be persisted page terminality plus task counts, not in-memory counters.

ASAP risk: no merge blocker found.

### 6. Metadata Fetch / Store

Current concurrency setting: `BOOTSTRAP_METADATA_CONCURRENCY=8`.

Bubbled into main config: yes.

Current model:

- The metadata step is one leased bootstrap step.
- Each pass reads up to `BOOTSTRAP_METADATA_BATCH_SIZE` due metadata tasks.
- The step processes the due tasks through an in-process bounded worker pool with width `BOOTSTRAP_METADATA_CONCURRENCY`.
- Each token calls the metadata domain refresh path, which stores canonical `tokens`, `token_metadata`, normalized attributes, and follow-up work.
- Failed tasks are moved to retry or terminal failure according to the bootstrap metadata retry policy and snapshot mode.
- Completion is derived from persisted metadata task counts.

Clean concurrency options:

- The current local concurrency model is coherent because only one leased metadata step selects tasks for a run at a time.
- To support multiple metadata workers or higher process-level concurrency cleanly, metadata tasks should get the same claim/lease/fenced-settlement model as collection-extension artifact tasks.
- Without task leases, raising queue-level concurrency for metadata would risk duplicate reads of the same due tasks. Current local `mapWithConcurrency` avoids that by keeping selection inside one step processor.

ASAP risk: no merge blocker found.

### 7. Token Image Cache Side Lane

Current concurrency setting: `BOOTSTRAP_IMAGE_CACHE_CONCURRENCY=4`.

Bubbled into main config: yes.

Current model:

- The image-cache step is a non-blocking side lane that depends on metadata.
- The bootstrap worker has a separate `collection-bootstrap-image-cache` queue consumer, but it is subscribed with `maxInFlight: 1`.
- The image-cache lane claims one image-cache step with a persisted step lease.
- Each pass reads up to `BOOTSTRAP_IMAGE_CACHE_BATCH_SIZE=50` due image-cache tasks.
- The due batch is processed through an in-process bounded worker pool with width `BOOTSTRAP_IMAGE_CACHE_CONCURRENCY`.
- Success writes the settled `token_image_cache` row transactionally with task success. If the task settlement loses the race, the newly written file is deleted.
- Image cache failures can become terminal without failing collection liveness.

Clean concurrency options:

- The current local concurrency model is coherent for one process/lane.
- Clean multi-worker image-cache concurrency would require per-task leases and fenced success/retry settlement. The storage shape is close but does not currently claim individual image-cache tasks before external fetch/resize work.
- A dedicated image-cache task lifecycle module, shaped like collection-extension artifact lifecycle, would be the clean path if this lane needs process-level scaling.

ASAP risk: no merge blocker found.

### 8. Collection-Extension Artifacts

Current concurrency setting: `BOOTSTRAP_COLLECTION_EXTENSION_ARTIFACT_CONCURRENCY=2`.

Bubbled into main config: yes.

Current model:

- Metadata completion makes the collection-extension artifact step ready when the run has an embedded extension.
- The main bootstrap lane seeds metadata-derived artifact tasks and extension-owned artifact tasks in one SQLite transaction.
- For Terraforms, extension-owned tasks include synthetic unminted-placement artifact tasks.
- The main lane publishes due artifact tasks to the dedicated `collection-extension-artifacts` queue.
- The collection-extension worker subscribes with `maxInFlight` equal to `BOOTSTRAP_COLLECTION_EXTENSION_ARTIFACT_CONCURRENCY`.
- Each bootstrap artifact task has `lease_owner` and `lease_until`.
- Workers claim pending/retry tasks with a persisted lease, renew that lease while rendering/fetching, and only the current lease owner can settle success, retry, or terminal failure.
- Completion and final stats release are derived from persisted artifact task counts.
- Synthetic Terraforms rows are published atomically with their extension artifact and trait writes, and synthetic identities are tombstoned when retired so delayed bootstrap tasks cannot recreate them after a real mint refresh.

Clean concurrency options:

- This is the strongest concurrency model in the bootstrap pipeline today.
- Scaling is mainly a matter of increasing `BOOTSTRAP_COLLECTION_EXTENSION_ARTIFACT_CONCURRENCY`, bounded by RPC capacity, renderer cost, HTTP fetch rate, and SQLite write pressure.
- If worker count is increased across processes, the per-task lease/fence model already provides the required correctness boundary.

ASAP risk: no merge blocker found.

### 9. Ownership Snapshot

Current concurrency setting: 1.

Bubbled into main config: no. `BOOTSTRAP_SNAPSHOT_BATCH_SIZE=200` is only a batch size.

Current model:

- The ownership step depends on metadata.
- Ownership tasks are seeded from metadata task token ids.
- Each pass reads up to `BOOTSTRAP_SNAPSHOT_BATCH_SIZE` due ownership tasks.
- Tasks are processed serially. Each task calls `ownerOf(tokenId)` at the anchor block.
- Success writes a snapshot row and marks the ownership task succeeded in a transaction.
- Once all ownership tasks succeed, `finalizeSnapshot` projects the snapshot into current ownership state at the anchor block.
- Ownership is mandatory: terminal ownership task failures fail the bootstrap run and block collection liveness.

Clean concurrency options:

- The right upgrade is not a quick local `mapWithConcurrency` alone. Ownership is correctness-critical and should use durable per-task claim/lease/fenced settlement before external `ownerOf` calls run concurrently.
- A clean implementation would add:
  - ownership task lease fields,
  - `claimOwnershipTask`, `renewOwnershipTaskLease`, and fenced success/retry ports,
  - an application lifecycle handler analogous to collection-extension artifact lifecycle,
  - `BOOTSTRAP_OWNERSHIP_CONCURRENCY` in the settings manifest and typed config,
  - tests for stale lease owners, retry scheduling, terminal failure, snapshot finalization after all task terminality, and resume after crash.
- Snapshot finalization should remain a single transaction after all ownership tasks are terminal. Parallel `ownerOf` calls must not imply parallel finalization.

ASAP risk: no merge blocker found, but this is the clearest future throughput improvement.

### 10. Short Backfill

Current concurrency setting: `BACKFILL_WORKER_COUNT=1`.

Bubbled into main config: yes, under sync config rather than bootstrap config.

Current model:

- The bootstrap backfill step schedules collection-scoped current-state catchup ranges from `anchor + 1` to current head.
- Range size is `BACKFILL_BATCH_SIZE=10`.
- Jobs go to the shared `events-sync-backfill` queue.
- The sync worker subscribes with `maxInFlight` equal to `BACKFILL_WORKER_COUNT`.
- `BackfillExecutionGate` allows fully pre-anchor facts-only ranges to run in parallel, but serializes ranges that may touch current-state projections.
- Bootstrap catchup is intentionally post-anchor and uses current-state order maintenance, so it is effectively serialized by default and should remain ordered.

Clean concurrency options:

- Raising `BACKFILL_WORKER_COUNT` is safe for pre-anchor facts-only historical imports, but it does not automatically make bootstrap catchup parallel because current-state ranges are serialized by design.
- Clean current-state backfill parallelism needs a fetch/apply split:
  - fetch logs/blocks in parallel for ranges,
  - persist raw/fact data idempotently,
  - apply current-state projections through an ordered per-collection barrier by block/log order,
  - commit coverage only after ordered apply completes.
- Another clean option is per-collection current-state lanes where independent collections can apply in parallel, but any shared contract/order side effects must be proven collection-scoped first.
- Do not bypass `BackfillExecutionGate` just to make bootstrap faster. That would weaken ownership/order projection correctness.

ASAP risk: no merge blocker found.

### 11. Collection Live

Current concurrency setting: effectively 1.

Bubbled into main config: no.

Current model:

- The collection-live step depends on backfill.
- It reads the backfill live block from step result, marks the collection bootstrap finished, marks the run completed, and cleans successful temporary data.
- For runs without collection extensions, it enqueues final stats recompute directly.
- For runs with collection extensions, final stats are released by extension artifact terminality instead, so extension-owned traits are included.

Clean concurrency options:

- No dedicated concurrency is needed. This is a small finalization step.
- If main-lane concurrency is added later, collection-live remains protected by its step lease and collection/run state checks.
- The important invariant is transactional finalization after backfill coverage, not throughput.

ASAP risk: no merge blocker found.

### 12. OpenSea Bootstrap

Current concurrency setting: 1.

Bubbled into main config: no. The OpenSea runtime has page size, retry, stale-start, subscription poll, and rate-limit settings, but no bootstrap concurrency setting.

Current model:

- Bootstrap plans OpenSea side-lane steps only when OpenSea integration is enabled and an explicit slug exists.
- After metadata and ownership, bootstrap schedules one OpenSea bootstrap job.
- The OpenSea bootstrap worker subscribes with `maxInFlight: 1`.
- The worker marks identity running/succeeded, snapshot running, then calls `OpenSeaOrderbookSync.syncCollection`.
- The orderbook sync paginates listings serially, then offers serially.
- Each REST record is published to the offchain raw queue.
- When the REST snapshot completes, the source-state store marks missing orders inactive for the run's active order id set, then the collection OpenSea state is marked ready.

Clean concurrency options:

- A dedicated `OPENSEA_BOOTSTRAP_CONCURRENCY` setting could be added, but only with per-collection snapshot ownership guarantees.
- Clean requirements:
  - prevent two OpenSea snapshot runs for the same collection from concurrently marking missing orders inactive,
  - fence work by latest bootstrap/reconcile run id,
  - share API rate limiting across concurrent snapshots,
  - keep OpenSea bootstrap step terminality tied to the correct run,
  - preserve idempotent raw observation dedupe keys.
- Page-level parallelism is not obviously clean because pagination cursors are sequential. The safe first concurrency boundary is collection-level, not page-level.

ASAP risk: no merge blocker found.

### 13. Metadata Stats Follow-Ups

Current concurrency setting: effectively 1 in the domain worker.

Bubbled into main config: no.

Current model:

- Metadata snapshot completion enqueues an early canonical stats recompute.
- Collection-extension artifact terminality enqueues final stats recompute for extension collections.
- Non-extension collection-live completion enqueues final stats recompute directly.
- Domain worker queues are subscribed with `maxInFlight: 1` for metadata stats processing.

Clean concurrency options:

- If stats recompute becomes expensive, add per-collection stats leases or versioned recompute rows before raising worker concurrency.
- Recomputes for different collections can be parallel only when each job owns a distinct collection and final writes are fenced by collection/reason/run version.

ASAP risk: no merge blocker found.

## Design Assessment

The pipeline already has three different concurrency tiers:

1. Durable step leases for bootstrap phase orchestration.
2. Local bounded worker pools for metadata and image cache task batches.
3. Durable per-task leases for collection-extension artifacts.

That split is coherent as long as the process-level concurrency is only enabled where the persistence model can fence duplicate work. Collection-extension artifacts satisfy that standard today. Metadata and image cache are clean local pools but should not be scaled by adding more queue consumers until they get task leases. Ownership is serial because it is correctness-critical and currently lacks task leases.

The strongest next concurrency improvement would be ownership task leases plus a typed `BOOTSTRAP_OWNERSHIP_CONCURRENCY` setting. The strongest large-scale enumeration improvement would be persisted enumeration page tasks rather than a larger in-memory `tokenByIndex` loop.

## Merge-Readiness Notes

No ASAP correctness blocker was found in this audit. The immediate documentation gaps were:

- `docs/indexer/01-config-and-env.md` listed stale `BACKFILL_BATCH_SIZE=50` while manifest/generated defaults use `10`.
- `docs/indexer/01-config-and-env.md` omitted `BOOTSTRAP_METADATA_BATCH_SIZE` and `BOOTSTRAP_METADATA_CONCURRENCY`.

Those gaps were fixed alongside this audit document so the config docs match the branch.
