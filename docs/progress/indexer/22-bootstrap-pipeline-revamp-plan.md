# Bootstrap Pipeline Revamp Plan

Status: in progress; first implementation pass landed; follow-up audits found
remaining liveness gaps in the leased orchestrator design; scheduler-first
pipeline design is now the target before moving to medium-priority cleanup

This plan replaces the current procedural bootstrap flow with a persisted,
stateful, idempotent pipeline. The current code and schema may be redesigned
from scratch for this work; there is no compatibility requirement for existing
local development databases.

## Problem

The current bootstrap worker is a linear call stack with a few durable task
tables bolted on. That worked for metadata-first bootstrap, but it is no longer
a good fit for the requirements now visible:

- token image caching can take far longer than correctness-critical bootstrap
  work because collection images may be hosted on very slow servers
- image caching is a local presentation optimization and should not block a
  collection from becoming live
- metadata and image-cache work need explicit pause/resume controls
- ownership snapshot needs per-token durability and retry semantics like
  metadata, not one monolithic loop
- progress, errors, and controls should be step-native rather than inferred from
  scattered worker state

## Goals

- Model bootstrap as a persisted pipeline planned from the original bootstrap
  request.
- Make every step idempotent: a worker can rerun a step safely after crash,
  retry, restart, or duplicate queue delivery.
- Separate blocking correctness steps from non-blocking presentation and
  integration side lanes.
- Provide first-class pause/resume for expensive async steps.
- Keep the pipeline composable so extensions, OpenSea, media cache, and future
  steps can attach without rewriting the whole worker.
- Preserve local-first behavior: no centralized ArtGod service is introduced.

## Non-Goals

- No backward-compatible migration path for existing dev bootstrap rows.
- No separate image-cache worker binary just to satisfy this revamp.
- No UI-only pause simulation. Pause/resume must be persisted and enforced by
  the runtime.
- No special collection-specific branching in generic bootstrap orchestration.

## Pipeline Model

Bootstrap should be represented by durable rows:

- `bootstrap_runs`: immutable request/config snapshot and top-level lifecycle.
- `bootstrap_run_steps`: one row per planned step for a run.
- step task tables for fan-out work where needed.

The bootstrap request should contain enough information to materialize the whole
run plan up front. Workers then reconcile persisted state rather than relying on
which function was previously called in the same process.

## Step Contract

Each `bootstrap_run_steps` row should carry at least:

- `run_id`
- `step_key`
- `status`
- `blocking`
- `depends_on` or a normalized dependency table
- `attempts`
- `next_attempt_at`
- `lease_until` / lease owner fields if concurrent execution is possible
- `progress_completed`
- `progress_total`
- `config_json`
- `result_json`
- `last_error`
- timestamps

Proposed step statuses:

- `pending`
- `ready`
- `running`
- `paused`
- `succeeded`
- `failed_retry`
- `failed_terminal`
- `skipped`

The exact serialized values should be owned by a bootstrap domain contract and
imported everywhere, not repeated as raw literals.

## Planned Steps

The initial planned graph should include:

- `anchor`
- `enumeration`
- `metadata`
- `ownership`
- `backfill`
- `collection_live`
- `image_cache` when the selected image cache mode is active
- `opensea_identity`, `opensea_snapshot`, and `opensea_ready` when OpenSea is in
  scope
- extension side-effect steps when extension installs require explicit work

Step dependencies should be data dependencies, not call-stack order.

## Blocking Policy

Blocking steps gate collection liveness. Non-blocking steps can run after the
collection is live.

Initial policy:

- `anchor`: blocking
- `enumeration`: blocking
- `metadata`: blocking
- `ownership`: blocking
- `backfill`: blocking
- `collection_live`: blocking terminal marker
- `image_cache`: non-blocking
- collection-extension artifact refresh: non-blocking
- OpenSea bootstrap: non-blocking for local ownership correctness

Image cache must not hold ownership, backfill, or collection-live progress.

## Target Runtime Model

One bootstrap runtime process can still own this, but it must behave as a
small durable scheduler plus bounded step executors. Queue messages are wake
signals only; `bootstrap_run_steps` is the source of truth.

The runtime should start one scheduler loop per lane:

- main blocking lane: anchor, enumeration, metadata, ownership, backfill, and
  collection-live transitions
- image-cache lane: image-cache tasks and policy refresh work
- integration side lanes: OpenSea and collection-extension artifact steps if
  they stay in the bootstrap graph

Each scheduler loop:

1. reconciles dependency-satisfied `pending` steps into `ready`
2. claims due `ready` or retryable steps for its lane
3. reclaims expired `running` leases for local or delegated work
4. executes a bounded processor batch
5. persists a terminal, retry, delegated, or pause-aware outcome
6. immediately repeats reconciliation after terminal outcomes
7. sleeps only when there is no due local work

Queue jobs, startup sweep, and pause/resume should only notify the relevant
lane loop. Losing a queue wake must not strand the run; the scheduler loop must
eventually pick up any due nonterminal step from durable state.

No step should require the previous step to have completed in the same job
handler invocation.

## No-Gap Liveness Invariants

Every planned step must be in exactly one durable liveness bucket:

- blocked: `pending` with unsatisfied dependencies
- claimable now or later: `ready` / retryable with `next_attempt_at`
- locally executing: `running` with a non-null lease owner and lease deadline
- externally delegated: `running` with a non-null health-check deadline
- paused: `paused`, never claimable until resume
- terminal: `succeeded`, `skipped`, or terminal failure

These invariants are mandatory:

- A nonterminal step must always have a future path to a scheduler claim or a
  resume action.
- `running` must never be stored without a lease or health-check deadline.
- Releasing an incomplete step must update durable scheduling state before any
  optional queue notification.
- Queue redelivery timing must not be relied on for liveness.
- Step processors must be idempotent under duplicate wake jobs, duplicate
  claims after expired leases, and process restart.
- A processor must not return a terminal outcome unless the step row is already
  terminal or the orchestrator terminalizes it in the same state transition.
- Step exceptions must be converted into retry or terminal state by the
  orchestration boundary; they should not leave a live lease as the only
  recovery path.

## Async Fan-Out Steps

The following steps should have per-token task tables:

- metadata snapshot
- ownership snapshot
- image cache

Each task table should support:

- `pending`
- `retry`
- `paused` only if task-level pause is truly needed; prefer step-level pause
- `succeeded`
- `failed_terminal`
- attempt counters and next-attempt scheduling
- last error fields

Pause/resume should normally be step-level, not a mass update of token tasks.

## Scheduler And Lease Contract

The scheduler is responsible for all step execution. Queue handlers should not
drive step-to-step progression directly.

Claiming rules:

- claim only steps belonging to the scheduler lane
- claim `ready` and retryable steps only when `next_attempt_at` is due
- reclaim `running` steps only when their lease or delegated health-check
  deadline is due
- update `status`, `lease_owner`, `lease_until`, and `started_at` atomically in
  the claim statement
- treat a zero-row claim update as a benign race

Release rules:

- terminal outcome: persist terminal step state and clear lease fields
- incomplete outcome: release to `ready` with the next due timestamp
- retry outcome: persist retry state, attempts, last error, and next due
  timestamp
- delegated outcome: leave `running`, clear local lease owner if needed, and
  persist a non-null health-check deadline
- paused outcome: leave `paused`, clear lease fields, and do not schedule a due
  wake until resume

The scheduler loop should keep running while it can claim due work. When it
cannot claim anything, it should sleep until the earliest due step for its lane
or a bounded polling interval, whichever is smaller. This keeps the design
event-driven in normal operation while still closing lost-wake gaps.

## Processor Outcome Contract

Step processors should return a small domain-owned outcome instead of raw
handler decisions:

- terminal: the processor has persisted `succeeded`, `skipped`, or terminal
  failure state
- incomplete: bounded work completed, more due or future work remains
- retry: the step-level processor failed before task-level retry handling could
  fully absorb the error
- delegated: work has been handed to another durable queue or runtime path
- paused: the step was paused before or during claim processing

The orchestrator must validate the outcome:

- terminal requires the current persisted step state to be terminal
- incomplete requires a non-null next attempt timestamp
- retry requires a non-null next attempt timestamp and persisted error context
- delegated requires a non-null health-check timestamp
- paused requires the current persisted step state to be paused

Validation failures should be treated as orchestration bugs: persist a terminal
or retryable orchestration error according to the step's blocking policy and
emit a structured error event. Silent terminal returns are not acceptable.

## Queue And Wake Semantics

Queue messages are notifications, not state. A message may be duplicated,
delayed, redelivered too soon, or lost during process shutdown. The scheduler
must still make progress from `bootstrap_run_steps`.

The queue should still be used for:

- creating a bootstrap run from a backend request
- nudging a lane after API resume
- waking a lane quickly after a step terminalizes another step's dependencies
- handing delegated side work to existing runtimes

The scheduler must not depend on a future queue job being published after every
release. Durable step state and lane polling are the recovery mechanism. Queue
notifications only reduce latency.

When publishing wake jobs is useful, the job identity should be idempotent for
the same run, step, lane, and due timestamp, while still allowing a later due
timestamp to publish a new wake.

## Delegated Work Contract

Some bootstrap steps delegate work to another queue or runtime path:

- backfill delegates block-range sync work
- OpenSea bootstrap delegates marketplace identity/snapshot work
- collection-extension artifacts delegate extension refresh jobs

Delegated work remains a bootstrap step. The scheduler-owned step row must stay
authoritative:

- the step enters `running` with a non-null health-check deadline
- delegated jobs must be idempotent and carry enough bootstrap context to update
  the step/task rows
- when the health-check deadline expires, the scheduler may republish missing
  delegated work, recompute progress, or terminalize the step
- delegated workers should terminalize or retry the step through the same
  bootstrap step port, not by ad-hoc table updates

This avoids the current ambiguous state where a side step can be `running`
without a claimable lease or scheduled health check.

## Failure Policy

Failure handling should be layered:

- per-token task failures are handled inside the task table first
- step-level processor exceptions become step retry state with backoff
- repeated orchestration failures become terminal step failures
- blocking terminal failures fail the bootstrap run
- non-blocking terminal failures keep the collection live but remain visible in
  the run detail/history

Ownership remains mandatory. Ownership terminal failures must block collection
liveness. Metadata and image-cache terminal task failures follow their step
policy: metadata can complete in best-effort mode when no pending/retry tasks
remain; image-cache can complete with terminal image failures because it is a
presentation optimization.

## Pause And Resume

Pause:

- sets the step status to `paused`
- prevents the executor from claiming new batches
- lets already in-flight batches finish
- keeps progress and error history intact

Resume:

- sets the step status back to `ready` or `failed_retry`
- schedules or wakes the bootstrap orchestrator
- continues from persisted task/progress state

Initial UI controls should exist for:

- metadata
- image cache

Other bootstrap steps can continue without pause/resume until they prove
operationally expensive enough to justify controls.

## Image Cache Lane

Image caching should become a non-blocking side lane:

- seed image-cache tasks after metadata rows with `token_metadata.image` are
  available
- immediately continue the blocking path to ownership/backfill/live
- process image-cache tasks independently after the collection is live
- keep progress visible in bootstrap run detail
- allow pause/resume while preserving completed cached images

This can run asynchronously inside the current bootstrap runtime process. A
separate worker binary is not required for the first implementation.

## Ownership Snapshot Revamp

Ownership should become taskized:

- one task per token
- `ownerOf(tokenId)` at the bootstrap anchor block
- per-token retry and terminal failure state
- durable progress from task counts
- resumable after crash or provider failure

This removes the current monolithic ownership loop and makes ownership behave
like metadata with respect to progress, retry, and observability.

## Observability

Every step executor should emit structured logs with:

- `component`
- `action`
- `runId`
- `stepKey`
- `chainId`
- `collectionId`
- batch sizes and progress counts
- pause/resume transitions
- failure class and retry scheduling

RPC calls stay on the shared RPC harness and keep their existing RPC catalog
entries. Step logs should add bootstrap-domain context that the generic RPC logs
intentionally do not carry.

## Backend And UI Contract

The run detail API should be driven by `bootstrap_run_steps` plus task counts.

Each flow step should expose:

- key
- label
- state
- progress
- detail text
- whether it is blocking
- whether it is pausable
- whether it is paused
- available actions

The frontend should render compact controls under the metadata and image-cache
chips:

- pause when the step is running or ready
- resume when the step is paused

The API should provide dedicated pause/resume endpoints for a run step.

## Schema Direction

Because development DB compatibility is not required, prefer replacing the
current bootstrap schema over layering many compatibility columns.

Likely schema work:

- replace or rewrite bootstrap run migrations that are only present on this dev
  branch
- add `bootstrap_run_steps`
- add or rebuild metadata, ownership, and image-cache task tables around shared
  step semantics
- remove any bootstrap state that only existed to support the procedural flow

The settled domain tables remain separate concerns:

- `token_metadata`
- normalized token attributes
- `nft_balances`
- `token_image_cache`

Bootstrap tables should track pipeline progress and tasks, not become permanent
domain state.

## Decisions

These decisions are locked for the next implementation pass:

- Store step dependencies as JSON on `bootstrap_run_steps`. A normalized
  dependency table is unnecessary until dependency queries become complex.
- Use scheduler-first orchestration. Queue wake events are latency hints; the
  lane scheduler must poll durable step state so lost, early, or duplicated
  queue messages cannot strand a run.
- The scheduler loop is generic to bootstrap lanes, not an image-cache-specific
  reconciler. It should be bounded, indexed, and configurable.
- Every `running` step must have either a live local lease owner or a delegated
  health-check deadline. `running` with no deadline is invalid.
- Processor outcomes must be validated against the persisted step row before
  the orchestrator accepts them.
- Treat ownership as mandatory. Ownership failures must block collection
  liveness; there is no best-effort path where ownership can be skipped or
  terminally failed while the collection becomes live.
- After a run fully succeeds, delete per-token bootstrap task rows and other
  temporary bootstrap data for that run.
- Keep `bootstrap_run_steps` as the historical journal. Preserve step
  `started_at`, `finished_at`, status, progress totals, and result summaries so
  users can inspect how long each step took after the fact.

## Completed First-Pass Work

The first pass already established important pieces:

1. Bootstrap pipeline domain constants and step rows.
2. A pipeline planner from the bootstrap request.
3. Taskized metadata, ownership, and image-cache work.
4. Non-blocking image-cache lane.
5. Side-lane terminalization for OpenSea and collection-extension artifacts.
6. Per-lane successful-task cleanup while preserving `bootstrap_run_steps`.
7. Backend run-detail read model and pause/resume routes.
8. Frontend progress chips and pause/resume controls.
9. Focused storage, executor, startup, backend, and frontend tests.

The latest lease-based executor pass removed the largest direct phase
handoffs, but the post-commit audit found that it is still not the final
no-gap design because it lacks scheduler-owned liveness after incomplete
release, processor exceptions, and delegated `running` work.

## Required Final Architecture Work

These are the remaining critical/high issues before moving to medium-priority
cleanup:

1. Build the scheduler-first lane loops.
   The lane scheduler must poll indexed `bootstrap_run_steps` state, claim due
   work, reclaim expired leases, and keep processing until the lane is idle.
   Queue wakes should notify the loop but not be required for progress.

2. Make releases self-contained.
   Incomplete, retry, and delegated outcomes must persist enough state for the
   scheduler to pick them up again without another queue message. This closes
   the current lost-wake and max-iteration liveness gap.

3. Add processor exception handling at the orchestration boundary.
   Exceptions must release or retry the step according to a step-level retry
   policy. A throw must not leave a live lease as the only recovery path.

4. Enforce processor outcome invariants.
   Terminal outcomes require terminal persisted state; delegated outcomes
   require a health-check deadline; retry/incomplete outcomes require a next
   attempt timestamp. Violations should be persisted as orchestration errors.

5. Normalize delegated side-lane processing.
   Backfill, OpenSea, and collection-extension artifact steps should all use the
   same delegated-step contract: `running` with a non-null health-check
   deadline, idempotent delegated job publish, progress recompute, retry, and
   terminalization.

6. Generalize completed-run recovery.
   Completed runs can still have non-blocking recoverable work. Startup and the
   lane scheduler should recover any nonterminal non-blocking step, not just
   image-cache work.

7. Strengthen lifecycle and liveness tests.
   Tests must prove scheduler behavior, not merely handler behavior.

## Implementation Milestones

### Milestone 1: Scheduler Core

Goal: make the orchestration boundary impossible to strand from normal
incomplete work or exceptions.

Implementation:

- Add lane scheduler loops inside the bootstrap runtime.
- Add storage methods for selecting the earliest due step by lane and for
  claiming due local/delegated work.
- Replace "run loop once because a queue message arrived" with "notify the lane
  scheduler and let it claim durable work".
- Convert current release helpers into validated scheduler outcomes.
- Ensure processor exceptions become step retry or terminal failure state.
- Reject or terminalize invalid terminal/delegated outcomes instead of silently
  returning.

Test gate:

- unit: due `ready` step is claimed without a queue wake
- unit: incomplete outcome with future due timestamp is picked up later
- unit: max-iteration exhaustion cannot strand remaining due work
- unit: processor throw releases to retry with backoff and clears the local
  lease
- unit: invalid terminal outcome is detected and persisted as an orchestration
  error
- storage: expired `running` lease is reclaimable; unexpired lease is not

### Milestone 2: Main Blocking Lane E2E

Goal: prove the blocking path is fully scheduler-driven.

Implementation:

- Port anchor, enumeration, metadata, ownership, backfill, and collection-live
  transitions onto scheduler-owned outcomes.
- Remove remaining handler-specific assumptions from main bootstrap queue jobs.
- Make backfill delegated work use a health-check deadline instead of relying
  on a one-off delayed check job for liveness.

Test gate:

- integration: anchor through collection-live succeeds through SQLite adapters
  without direct handler handoffs
- integration: metadata best-effort completes with terminal metadata task
  failures only when no pending/retry tasks remain
- integration: ownership terminal task failure blocks collection liveness
- integration: backfill delegated range sync is republished or checked after
  health-check expiry
- integration: duplicate queue wakes do not duplicate domain side effects

### Milestone 3: Non-Blocking And Delegated Side Lanes

Goal: make image-cache, OpenSea, and extension artifact work composable,
recoverable, and terminal.

Implementation:

- Keep image-cache as a separate scheduler lane.
- Convert OpenSea and collection-extension artifact steps to the delegated
  contract with health-check deadlines.
- Make completed-run recovery generic for non-blocking nonterminal steps.
- Preserve collection liveness while non-blocking side lanes continue.

Test gate:

- integration: image-cache continues after collection live and reaches terminal
  state
- integration: image-cache pause/resume is honored by the scheduler
- integration: OpenSea delegated steps reach terminal success/skip/failure
- integration: collection-extension artifact tasks reach terminal state after
  delegated refresh jobs
- startup: completed run with nonterminal side-lane step is recovered

### Milestone 4: Runtime, Queue, And Recovery Hardening

Goal: prove process and queue failures do not break liveness.

Implementation:

- Treat NATS jobs as wake signals only.
- Add scheduler notification on startup, resume, and terminal step transitions.
- Add graceful shutdown behavior that does not corrupt claimed step state.
- Add observability fields for scheduler claim, release, retry, delegation, and
  health-check transitions.

Test gate:

- runtime/integration: early redelivery before lease expiry is harmless and does
  not consume the only future wake
- runtime/integration: lost wake is recovered by scheduler polling
- runtime/integration: restart recovers `ready`, retryable, and expired
  `running` steps
- runtime/integration: paused steps are not claimed and resume makes them due
- observability: scheduler logs include run, step, lane, claim/release action,
  and retry/delegation context

### Milestone 5: API/UI Consistency Pass

Goal: expose the settled scheduler model without UI drift.

Implementation:

- Ensure run-detail progress reads from `bootstrap_run_steps` plus task counts
  without relying on deleted succeeded task rows.
- Ensure pause/resume endpoints notify the scheduler and clear local leases.
- Keep frontend chips consistent for blocking, non-blocking, delegated, paused,
  retrying, and terminal states.

Test gate:

- backend: run-detail exposes correct state/progress/action availability for
  scheduler states
- frontend: chips show progress and pause/resume controls without relying on
  stale task rows
- E2E: bootstrap page reflects scheduler-driven progress across metadata,
  ownership, image-cache, and completed-run side-lane recovery

## Later High-Priority Cleanup

These remain important but should wait until the scheduler design is coherent:

1. Align RPC zero-data behavior and documentation.
   The code now treats provider zero-data and historical-state unavailable
   errors as retryable provider failures, while deterministic contract failures
   still short-circuit. The RPC catalog still has text that groups zero returned
   data with deterministic no-retry behavior in places. Update the catalog and
   add focused coverage so missing methods/reverts still short-circuit quickly
   during probing, while provider zero-data from flaky endpoints rotates/retries.

2. Avoid loading `sharp` for original-byte image-cache passthrough.
   The image cache adapter currently imports `sharp` even when no resize is
   requested, only to inspect dimensions. For `maxDimension = null`, passthrough
   should preserve original bytes without requiring native image processing.
   Dimension extraction can be skipped or handled by a lightweight optional
   probe. Resizing should remain the only path that requires `sharp`.

3. Remove remaining hard-coded semantic literals from new bootstrap surfaces.
   The first pass centralized most pipeline vocabulary, but some frontend and
   backend bootstrap code still repeats statuses, standards, route/action
   values, and task states directly. Import the owning constants/contracts in
   production code and tests unless a test is intentionally asserting storage or
   wire serialization.

## Open Decisions

- Exact scheduler polling floor/ceiling defaults. The loop must be bounded and
  configurable, but the first implementation can choose conservative defaults
  and tune after local runtime testing.
- Whether ownership should expose a dedicated operator retry action separate
  from generic step resume. This does not change ownership being mandatory.
- Whether non-blocking side-lane terminal failures should show a dedicated
  collection warning outside bootstrap history after the run itself is complete.
