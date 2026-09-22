# Adding a Startup Recovery Task

Startup recovery is a supervisor-owned prerequisite for starting local services.
Tasks run on each new infra start/restart, including automatic core restarts.
The supervisor provides process ownership, deadlines, status, cancellation and
terminal failure handling; the owning domain decides whether work is necessary
and safe. There is no task discovery, periodic scheduler, persisted completion
flag or generic resume cursor.

Read the [runtime lifecycle contract](01-tauri-build-and-runtime.md#supervisor-runtime-composition)
first. Use the following touchpoints when adding another task.

## Main Touchpoints

1. **Domain behavior and executable entrypoint.** Keep inspection, eligibility
   and mutations in the owning application/domain layer behind injected ports.
   Give the child a small composition root and typed config. It must exit zero
   only after verifying success, exit nonzero on failure, and close connections
   on both initialization and execution failures. Inspect current persisted
   state on every attempt; an already-correct state should need no repair.
   Cancellation can occur between writes, so define safe repeat behavior and
   any task-specific journal before adding mutations. NATS examples are
   [the use case](../../indexer/src/application/queue/maintain-nats-job-stream.ts),
   [adapter](../../indexer/src/infra/queue/nats-job-stream-maintenance.ts),
   [entrypoint](../../indexer/src/runtime/nats-job-stream-maintenance.ts) and
   [config](../../indexer/src/config/nats-job-stream-maintenance.ts).

2. **Task identity and execution contract.** Add a `RecoveryTaskId` in
   [recovery.rs](../../src-tauri/src/runtime/recovery.rs) and a `RecoveryTask`
   descriptor in [supervisor.rs](../../src-tauri/src/runtime/supervisor.rs).
   Reuse `execute_recovery_process_until` through `run_startup_recovery_step`;
   use `wait_for_recovery_service` for a prerequisite that stays running.
   Establish one monotonic work deadline before the task's first step and pass
   it through all prerequisites. Polling, progress, substeps and UI reloads must
   not renew it. Choose and document the new task's budget explicitly.

3. **Startup placement and cleanup.** Wire the task explicitly into
   `spawn_runtime_processes` before the services that depend on it. Use managed
   children and supervisor logging; retain ownership of every prerequisite.
   On Stop, timeout or failure, finish child/prerequisite cleanup before
   admitting another attempt. `run_startup_recovery_step` finalizes its child;
   its caller must stop any separately owned prerequisite on failure. Adapt
   `publish_recovery_cleanup` when the process arrangement differs: its current
   presentation budget accounts for a maintenance child and NATS stopping
   serially. The work deadline initiates cleanup; OS termination and output
   reader joins do not have a proven global deadline. Preserve the existing
   terminal failure/manual retry path and fresh-controller behavior.

4. **Build, resource staging and logs.** For a Node task, add its entrypoint to
   [build-runtime-artifacts.mjs](../../scripts/build/build-runtime-artifacts.mjs).
   Define its artifact path and process name in
   [process_registry.rs](../../src-tauri/src/runtime/process_registry.rs), and
   include its process in `runtime_log_process_names`. A short-lived recovery
   task does not belong in `INDEXER_WORKERS`. Existing package directories are
   copied by [resource staging](../../scripts/build/prepare-desktop-runtime-resources.mjs);
   update staging and reviewed dependency closures if introducing a new package
   or dependency. Rebuild with `yarn build:desktop-runtime` and
   `yarn build:desktop-runtime-resources`. Verify the staged entrypoint, chunks
   and dependencies with bundled Node, not only a source runner.

5. **Status and UI.** Mirror task identity in
   [ports.ts](../../frontend/src/lib/runtime/lifecycle/ports.ts) and add product
   wording in [startup-presentation.ts](../../frontend/src/lib/runtime/lifecycle/core/startup-presentation.ts).
   Publish `StartupActivity` while runtime state remains `starting`/`restarting`;
   keep `operationId` stable for the attempt and increment `revision` through
   the supervisor's status publisher. Timestamps describe the deadline; Rust's
   monotonic clock enforces it. Reuse the
   [orchestrator](../../frontend/src/lib/runtime/lifecycle/orchestrator.ts),
   [reducer](../../frontend/src/lib/runtime/lifecycle/core/reducer.ts) and
   [UI policy](../../frontend/src/lib/runtime/lifecycle-ui-policy.ts).
   Confirmed recovery uses its own deadline, while unavailable status remains
   bounded. Stop stays available; late status/API results cannot restore
   readiness after cancellation. Userland needs both core and API readiness.
   Task code never unlocks wallets or starts wallet-bound bots.

6. **Regression and rendered coverage.** Extend Rust serialization coverage and
   the [bridge fixture](../../src-tauri/tests/fixtures/runtime-recovery-status.json)
   as appropriate; preserve coverage of existing tasks. Test success, failure,
   timeout, Stop at each prerequisite, child cleanup and an effective fresh
   retry. Test domain preservation and interruption using synthetic local data.
   Extend [the maintained rendered harness](../../frontend/e2e/runtime-recovery.spec.ts)
   for any new task presentation and run `yarn test:runtime:recovery`; inspect
   both Admin and the standalone drawer. Run affected native tests, artifact
   builds, `yarn check:runtime-registry`, `yarn config:check`,
   `yarn check:docs` and `yarn test:docs`. Native packaged execution needs its own
   QA evidence; a browser bridge fixture does not establish it.

## NATS as the First Task

The NATS task has two short-lived children and one shared 15-minute deadline:

- Before NATS starts, the supervisor invokes the current desktop executable's
  Rust preparation mode. [main.rs](../../src-tauri/src/main.rs) dispatches it
  before Tauri initialization; [nats_store.rs](../../src-tauri/src/runtime/nats_store.rs)
  owns the storage lease and journaled metadata migration. This code is compiled
  into the desktop executable, so it needs no separate sidecar bundle entry.
- After the broker starts, bundled Node executes
  `indexer/dist-desktop/nats-job-stream-maintenance.mjs`. Its build entrypoint,
  package resource staging and bundled Node are part of the normal
  [Tauri build commands](../../src-tauri/tauri.conf.json).

Each launch checks metadata, stream/consumer state and write health. A healthy
queue requires no recovery purge; inspection and publish/delete probes still
run. Cleanup is limited to proven acknowledged leftovers and preserves valid
pending work regardless of age. Stop does not roll back completed mutations;
the next attempt inspects the resulting state, and the metadata journal handles
an interrupted two-file update. See [queue policy](../indexer/02-queues-and-jobs.md)
and the [native/NATS harness](../development/01-local-development.md#nats-startup-recovery-regression-harness).

## SQLite Market Data as a Subsequent Task

`sqliteMaintenance` runs
`indexer/dist-desktop/sqlite-market-data-maintenance.mjs` before backend/workers.
Its [use case](../../indexer/src/application/storage/maintain-market-data.ts)
and [adapter](../../indexer/src/infra/storage/sqlite-market-data-maintenance.ts)
own retention, a transactional stage/cursor journal, and the final checkpoint.
Additive migrations are small; legacy-scale removal does not run inside the
ordinary migrations transaction. Copy batches contain at most 500 rows and
yield between transactions. Atomic table replacement/index recreation and
receipt-table removal can take much longer than an individual copy batch.

`sqliteCompaction` uses the same artifact with `--compact-only` and the same
45-minute SQLite deadline. It is best effort after logical readiness, checks
headroom and records one automatic attempt before VACUUM. Stop still cancels the
startup attempt; other compaction failures log the gap and permit service
startup. Neither task deletes a WAL separately or performs a destructive reset.
The [compaction use case](../../indexer/src/application/storage/compact-market-data.ts)
owns eligibility and attempt ordering; its adapter owns SQLite operations.
Both tasks use the shared structured logger, with component
`IndexerSqliteMarketDataMaintenance` and explicit progress, completion and failure
actions. The [runtime contract](../../shared/market-data/recovery-runtime.json)
owns those labels and CLI arguments; a focused test checks native deadline/argument agreement.
Both have distinct process log names in the runtime registry and product labels
in Admin/the lifecycle drawer.

`yarn test:sqlite:recovery-runtime` uses bundled Node/native SQLite to test a
synthetic committed WAL, hard interruption, resume, idempotent retry and preserved
settings. The copy-only legacy verifier and measured results are documented in
[local development](../development/01-local-development.md#sqlite-storage-recovery-verification)
and the [storage evidence](../development/04-sqlite-wal-activities-storage-investigation.md#verification-record).

There is no standalone Admin task-launch action. Tasks currently run through
infra startup, with dependent services stopped. Running maintenance against
active producers would require a separately designed lifecycle.
