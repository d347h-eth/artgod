# Bootstrap Pipeline Revamp Plan

Status: in progress; first implementation pass partially landed

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

## Runtime Model

One bootstrap runtime process can still own this, but it should behave as an
orchestrator plus step executors:

1. The orchestrator finds ready steps whose dependencies are satisfied.
2. It claims or leases a bounded unit of work.
3. The executor processes a bounded batch.
4. It persists progress and result state.
5. It releases or completes the step.
6. It wakes the orchestrator for newly ready downstream steps.

No step should require the previous step to have completed in the same job
handler invocation.

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

These decisions are locked for the first implementation pass:

- Store step dependencies as JSON on `bootstrap_run_steps`. A normalized
  dependency table is unnecessary until dependency queries become complex.
- Use event-driven orchestration with a startup sweep. Step completion,
  pause/resume, and retry scheduling should wake the orchestrator explicitly.
  Do not add a continuous periodic image-cache reconciler in the first pass.
- Treat ownership as mandatory. Ownership failures must block collection
  liveness; there is no best-effort path where ownership can be skipped or
  terminally failed while the collection becomes live.
- After a run fully succeeds, delete per-token bootstrap task rows and other
  temporary bootstrap data for that run.
- Keep `bootstrap_run_steps` as the historical journal. Preserve step
  `started_at`, `finished_at`, status, progress totals, and result summaries so
  users can inspect how long each step took after the fact.

## Implementation Order

1. Define bootstrap pipeline domain constants and types. Done.
2. Replace schema with runs, steps, dependencies, and task tables. Done for the
   current first pass.
3. Build a bootstrap pipeline planner from the bootstrap request. Done.
4. Build orchestration/reconciliation helpers. Done for the current first pass:
   shared dependency helpers, an indexer startup reconciler, and worker startup
   sweep now promote dependency-ready steps and republish recoverable executor
   jobs through a tested application boundary.
5. Port anchor and enumeration into step executors. Partially done; current
   procedural start handler records step progress and delegates anchor/manual
   enumeration decisions to tested helpers, but is not yet a generic executor
   module.
6. Port metadata into a taskized step executor. Done.
7. Add taskized ownership executor. Done.
8. Make image cache a non-blocking taskized side lane. Done.
9. Port backfill and collection-live marking into step executors. Partially
   done; backfill/live scheduling decisions are isolated behind a tested helper,
   but current handlers are not yet generic executor modules.
10. Add backend run-detail read model from steps and task counts. Done.
11. Add pause/resume backend use cases and HTTP routes. Done for metadata and
    image cache.
12. Add frontend chip controls for metadata and image cache. Done.
13. Update canonical bootstrap docs and RPC catalog if any interaction paths
    changed. Done for docs; RPC catalog did not need a new JSON-RPC path.
14. Add focused backend/indexer/frontend tests, then E2E bootstrap coverage.
    Focused storage/reconciler tests added for the startup sweep. Bootstrap
    probe UI and run-detail pause/resume E2E coverage exists; full backend
    lifecycle E2E coverage remains.

## Open Decisions

- Whether the startup sweep should run only once at process start or also after
  reconnecting to the queue/database following transient infrastructure errors.
- Whether ownership should expose an operator retry action separate from generic
  step resume.
