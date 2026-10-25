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
- Deployment search: `shared/evm/contract-deployment.ts`
- Deployment enrichment: `indexer/src/application/bootstrap-deployment-executor.ts`, `indexer/src/infra/bootstrap/sqlite-deployment.ts`
- Bootstrap storage adapter: `indexer/src/infra/bootstrap/sqlite.ts`

## Current Configured Values

| Setting                                                 | Current default | Main config surface                                              | Notes                                                                                 |
| ------------------------------------------------------- | --------------: | ---------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| `BOOTSTRAP_METADATA_CONCURRENCY`                        |               8 | `IndexerConfig.bootstrap.metadataConcurrency`                    | Local worker-pool width inside the metadata step.                                     |
| `BOOTSTRAP_METADATA_BATCH_SIZE`                         |             200 | `IndexerConfig.bootstrap.metadataBatchSize`                      | Due task read/write batch size, not concurrency.                                      |
| `BOOTSTRAP_SNAPSHOT_BATCH_SIZE`                         |             200 | `IndexerConfig.bootstrap.snapshotBatchSize`                      | Ownership task seeding and processing batch size, not concurrency.                    |
| `BOOTSTRAP_IMAGE_CACHE_BATCH_SIZE`                      |              50 | `IndexerConfig.bootstrap.imageCacheBatchSize`                    | Due image-cache task read batch size.                                                 |
| `BOOTSTRAP_IMAGE_CACHE_CONCURRENCY`                     |               4 | `IndexerConfig.bootstrap.imageCacheConcurrency`                  | Local worker-pool width inside the image-cache step.                                  |
| `BOOTSTRAP_COLLECTION_EXTENSION_ARTIFACT_CONCURRENCY`   |               2 | `IndexerConfig.bootstrap.collectionExtensionArtifactConcurrency` | Queue max-in-flight for collection-extension artifact jobs.                           |
| `BOOTSTRAP_COLLECTION_EXTENSION_ARTIFACT_TASK_LEASE_MS` |           60000 | `IndexerConfig.bootstrap.collectionExtensionArtifactTaskLeaseMs` | Per artifact task lease duration.                                                     |
| `BACKFILL_BATCH_SIZE`                                   |              10 | `IndexerConfig.sync.backfillBatchSize`                           | Historical backfill range chunk size; bootstrap sends one coordinator wakeup.         |
| `BACKFILL_WORKER_COUNT`                                 |               1 | `IndexerConfig.sync.backfillWorkerCount`                         | Historical backfill queue max-in-flight; current catch-up belongs to the coordinator. |

There is no dedicated OpenSea bootstrap concurrency setting. The OpenSea bootstrap worker currently subscribes with `maxInFlight: 1`.

## Shared Concurrency Primitives

Queue workers use NATS JetStream durable consumers. `runWorker` forwards each worker's `maxInFlight` into the queue adapter, and the NATS adapter enforces it both as `maxAckPending` on the durable consumer and as an in-process limiter.

The bootstrap worker also runs three durable step scheduler lanes:

- main lane: anchor, enumeration, metadata, ownership, backfill, collection live, collection-extension artifact step coordination, and OpenSea step coordination
- image-cache lane: image-cache step only
- deployment lane: deployment-block enrichment only, starting when the necessary lookup input is available

Each lane's poller prevents overlap between its own timer callbacks. Queue
handlers can enter the same lane independently, so there is no process-wide
one-call-at-a-time lane lock. Each scheduler invocation visits due run ids
serially in oldest-due order, with run ID breaking ties. A run occupies one slot
using its earliest due step; an abandoned running step becomes due at lease
expiry. Waiting or page-yielding work moves behind older due work when it is
rescheduled, so the oldest run IDs cannot monopolize the bounded selection.
Startup-sweep candidates fill only slots left after due work. The orchestrator
claims ready steps using persisted step leases. `BOOTSTRAP_STEP_CLAIM_LIMIT` is currently `1`, so
a lane claims at most one step per run iteration. Step leases are renewed while
the processor runs only for the unexpired owner, and lease release is fenced by
owner. Orchestrator failure settlement carries that owner as well. Backfill
writes use the current run, anchor and unexpired step claim in one writer;
generic progress/success writers elsewhere do not yet carry that owner predicate.
Temporary shared-RPC allocation deferrals release the step back to ready at the
allocator's retry time, preserving its failure allowance and saved progress.

This coordinates the normal duplicate-delivery and repeated-poll path through
the durable step row, but it is not a complete stale-owner settlement fence.

Deployment enrichment separately fences result settlement by unexpired owner
lease and collection contract identity, saving the marker and terminal step in
one write transaction. Mint requests and writes also recheck enumeration's exact
token and anchor confirmation; replacing or removing it invalidates the attempt.
Its poller runs independently with one search at a time
and one outstanding RPC query. Mint searches perform one bounded successful
page per pass, starting at the contract deployment block found by the shared
historical code search. That bound and the verified empty prefix are persisted
before releasing the lease; each page does not repeat the code search.
The code search checkpoints every successful binary-search probe too. Shared
quota deferral or restart resumes its remaining probes for both code markers and
mint lower bounds, without spending the same successful requests again.
Retries and restart resume that cursor; rejected or timed-out pages do not
advance it. A changed pinned hash invalidates the code-search position, bound,
and mint cursor together. A mint retry must still match enumeration's confirmed
history; it cannot replace that hash with the new canonical hash. A confirmation
for the same token at another anchor starts a fresh search.
Unavailable code history remains an error rather than falling back to genesis
event queries. The configured log cap and learned reductions are shared with
ordinary log acquisition. It shares the bootstrap RPC provider's endpoint
budget and resilience policy. Neither collection liveness
nor run completion depends on its result; pause/retry and restart recovery use
the existing durable-step controls.

## Pipeline Steps

### 1. Register Collection / Create Run

Current concurrency setting: no dedicated knob.

Typed runtime config: no.

Current model:

- Backend use case validates the request, resolves embedded extension eligibility,
  checks for any non-failed prior run before changing the collection definition,
  upserts the collection, creates a bootstrap run plus planned steps, then
  publishes one `bootstrap.collection.start` job.
- Any non-failed run, including `completed`, prevents creating another run for
  that collection. The SQLite adapter repeats the check inside the definition
  and run-creation write transactions; prepared startup uses the same rule.
  The existing partial unique index covers only legacy active statuses, so the
  transaction check enforces the broader admission rule.
- The queue publish uses a start scope plus timestamp. JetStream deduplicates
  only an exactly reused generated job id; a fresh publication gets a fresh id.
  Run creation and queue publication are not one transactional boundary.
- Startup acknowledgement changes a run from `requested` to `queued` and records
  its queued event in one conditional transaction. If the indexer has already
  progressed, failed or completed the run, the acknowledgement preserves that
  state and records no queued event. The response reads the requested run's
  status, even if a newer attempt exists. Prepared startup uses the same
  conditional transition before publishing.

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
- Anchor work reads current head and subtracts reorg depth. One current-run and
  active-lease guarded writer publishes the anchor block/hash/timestamp, collection
  bootstrap start, run phase, step success and event. A late RPC reply from a
  failed or replaced run cannot restore its collection state.
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
- Manual token-id and manual-range runs iterate the configured candidates and
  read ownerOf at the anchor through Ethereum JSON-RPC. Only confirmed present
  tokens enter the snapshot; recognized absence reverts are skipped, while
  uncertain reads fail. No historical events or marketplace inventory are read.
- Enumerable runs store progress on the durable step at intervals of 1% of
  supply rounded down to whole tokens, with a minimum of one token and a
  maximum of 1,000 tokens. The initial and final counts are
  reported too. Run events retain their 1,000-token checkpoints, and heartbeat
  logging is unchanged. Run-detail chips display whole percentages and poll
  every five seconds, so fast checkpoints can be combined in one visible update.
- Enumeration retains its first confirmed token and anchor in the enumeration
  step result for deployment lookup. Completion, output, and the completion
  event are written atomically under the current lease and run identity. Task
  cleanup/reset does not remove that small result; count-only restart paths
  preserve it without deriving a token from task rows or current inventory.
- Manual ranges generate candidates lazily. The confirmed-present token list
  remains in memory for the existing metadata seeding boundary. Anchored owners
  are currently read again by ownership tasks; durable enumeration pages/owner
  reuse remain a separate scalability improvement.

Scaling boundary:

- The cleanest scalability upgrade is durable page/task enumeration:
    - create enumeration page tasks with cursor/index ranges,
    - claim pages with leases,
    - write discovered token ids into a staging table with unique constraints,
    - seed metadata tasks after all pages are terminal,
    - keep run progress derived from persisted page/task counts.
- A lighter local-only worker pool around `tokenByIndex` could reduce latency, but it is weaker because progress, retries, and crash recovery still depend on one long-running step. That is acceptable only if deliberately scoped as an optimization, not as the durable concurrency model.
- For large collections, a streamed approach would also avoid building the full token id array in memory. Token ids could be inserted into metadata tasks as pages complete, with completion determined by page task terminality.

#### Deferred Anchored Ownership Reuse

`BKL-037` in the [unified backlog](../planning/01-unified-backlog.md) retains
durable enumeration and ownership scaling, including reuse of the owners
already read for manual scopes. A future design may combine enumeration and
ownership work before metadata, but the current pipeline still has separate
steps and re-reads those owners. Any change must:

- bind staged token/owner results to the same run and anchor, never reuse a
  current-state probe owner as snapshot truth;
- distinguish confirmed presence, recognized absence, and uncertain errors
  through the owning RPC/domain contracts, without broad error-message matching;
- persist progress and ownership evidence with idempotent writes and active
  lease/generation fencing;
- preserve the complete configured scope for future mints while keeping the
  anchor's present subset separate;
- prove complete metadata seeding before terminal enumeration; the existing
  crash gap is tracked independently by `BKL-061`;
- preserve ownership finalization and catch-up gates before liveness, even if
  phase names or task organization change.

Design the durable boundary before raising concurrency or supporting very large
sparse intervals. This is snapshot work; it must not turn the short preflight
into event-history reconstruction or marketplace inventory discovery.

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
- Success writes a snapshot row and completes the task only when its captured
  run/anchor identity still matches. Late reads from a reseeded anchor write nothing.
- Once every task succeeds, installation captures the chain revision before a
  fresh exact-anchor check. `finalizeSnapshot` fences that revision, current run,
  anchor and active step lease, then writes balances in one transaction.
- Same-run crash retries may reinstall before Backfill acceptance. Installation
  after collection progress exists is rejected, preserving later ownership.
  Installing a snapshot never authorizes normal collection sync.
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

### 10. Applied Catch-Up

Current execution owner: the chain coordinator. Bootstrap retains and observes
completion; it does not acquire or apply current-state ranges independently.

- The step records a collection-scoped target from `anchor + 1` to the freshly
  observed head before publishing one `bootstrap_catchup` wakeup.
- Coordinator acquisition sizing belongs to sync policy. Bootstrap does not
  divide this wakeup into independent range jobs.
- Only the current run's successful Ownership step and retained final Backfill
  range authorize coordinator acceptance. The collection then catches up through
  already accepted chain history, stopping at its retained target until live.
  An older collection anchor is freshly verified and replays its own prefix to
  join the chain history without rewinding another collection.
- At most one older anchor receives fresh verification per coordinator pass.
  Failed verification retains `baseRetryAt` in the existing Backfill result,
  independently of scheduler health checks. Invalid/terminal steps are skipped
  before bounded selection, so they cannot hide healthy scopes.
- Completion requires the current revision, the run's exact anchor identity,
  and shared plus collection applied progress through the retained target.
  Raw `collection_sync_blocks` history cannot complete the step.
- No-post-anchor completion still requires an accepted collection checkpoint.
- The retained target survives restart and wakeup loss. Run phase, first target
  and queued event commit atomically under the current run, exact anchor and
  unexpired step lease. Progress and terminal status/result use the same writer
  boundary. Delayed HEAD responses cannot replace the first retained range or
  overwrite a replacement worker's successful handoff. Progress checks prefer
  that retained range over queue payloads; periodic coordination owns acquisition.
- Reorg recovery or an explicit disputed identity gates completion. There is
  no separate bootstrap gap-recovery publication or delivery identity loop.

The bootstrap step keeps completed/total progress and its next check time.
Collection-live consumes the retained finishing height, then independently
rechecks accepted progress before finalization.

### 11. Collection Live

Current concurrency setting: serial per scheduler invocation, not a global lane cap.

Typed runtime config: no.

Current model:

- The collection-live step depends on backfill.
- It reads the retained finishing block, rechecks accepted progress, freshly
  verifies the run's exact anchor hash and samples head. The explicit final
  invariant requires `HEAD - anchor >= REORG_DEPTH`.
- One SQLite transaction fences the run, step lease, chain revision, recovery
  state and accepted checkpoint; it marks the collection live, the live step
  successful and the core run completed, recording the completion event.
- For runs without extensions, that transaction retains the final statistics
  follow-up in the existing queue outbox. Extension artifact terminality retains
  the equivalent follow-up when extension-owned traits are ready.
- Successful temporary-task cleanup follows this atomic transition. Non-blocking
  side steps remain schedulable after core completion. Explicit post-live metadata
  retries retain their existing completion reconciliation behavior.

No RPC or broker call occurs in the final writer. A changed run, lost lease,
recovery or rewound progress prevents publication. Anchor depth is a supported
reorg-window condition, not absolute finality; a deeper orphaned snapshot requires
collection invalidation and a new bootstrap.

### 12. OpenSea Bootstrap

Current concurrency setting: 1.

Typed runtime config: no. The OpenSea runtime has page size, retry, stale-start, subscription poll, and rate-limit settings, but no bootstrap concurrency setting.

Current model:

- Bootstrap plans OpenSea side-lane steps only when OpenSea integration is enabled and an explicit slug exists.
- After `collection_live` succeeds and the core run is completed, bootstrap schedules one OpenSea bootstrap job. The non-blocking steps retain their existing run-page tracking and restart recovery after core completion.
- The worker requires the current live collection and the successful finalization of its originating bootstrap run. A queued job for a failed or removed run does not start a snapshot.
- The OpenSea bootstrap worker subscribes with `maxInFlight: 1`.
- The worker marks identity running/succeeded, snapshot running, then calls `OpenSeaOrderbookSync.syncCollection`.
- The orderbook sync paginates listings serially, then offers serially.
- Each REST record is published to the offchain raw queue.
- When the REST snapshot completes, the source-state store marks missing orders
  inactive for the run's active order id set, the collection OpenSea state is
  marked ready, and the source run is completed.
- Current collection lifecycle and latest bootstrap run identity guard scan
  membership, source withdrawals and readiness/completion/failure writes inside
  their writer transactions. Existing run identity also fences replacements with
  identical timestamps; no extra persisted generation is needed.
- Successful `collection_live` is the core-completion fact. Explicit post-live
  metadata retries may temporarily change run status without blocking the OpenSea
  side steps that completion reconciliation is waiting for.
- Stream subscriptions, event publication and raw consumption require a live
  collection with stream ingestion enabled. The initial snapshot and periodic
  live-only reconciliation provide eventual coverage without a bootstrap stream
  backlog or a gap-free handover requirement.

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
- OpenSea bootstrap is serialized at the collection snapshot boundary. Safe
  collection-level concurrency must fence missing-order reconciliation by the
  owning run and share API rate limits.
- Collection-extension task settlement is fenced, but artifact and trait writes
  occur first. Multi-process scaling needs idempotency/currentness proof or a
  fenced write boundary.
- Current-state catch-up has one runtime owner and durable expected-prefix/
  revision fences. Independent replicated acquisition is not a supported
  deployment contract; future parallel acquisition must preserve bounded
  buffering and the same ordered acceptance boundary.

The [unified backlog](../planning/01-unified-backlog.md) owns priority for these
directions; this document owns the invariants any implementation must preserve.
