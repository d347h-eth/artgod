# ArtGod Indexer Overview

This document describes the current indexer architecture and the main invariants the system relies on. It is meant to give a new contributor a complete mental model before diving into individual components.

## Purpose and Scope

The indexer is a local-first pipeline that reads blockchain data and marketplace data and builds a local queryable state for the ArtGod app.

Current scope:

- All processing runs locally on the user's machine.
- All cross-process communication goes through a durable queue (NATS JetStream).
- All persisted state lives in SQLite (`better-sqlite3`).
- Onchain ownership, metadata, and activities are maintained from RPC data.
- Offchain orders are ingested from OpenSea streams plus REST snapshot/reconcile passes.
- Collection-specific extensions can enrich indexing and presentation without changing canonical metadata or order storage.
- Every job is idempotent; at-least-once delivery is assumed.

## Runtime Topology

Each runtime is an independent Node.js process. There is no shared memory across runtimes.

- Scheduler-worker runtime (`indexer/src/runtime/scheduler-worker.ts`)
    - Tracks chain head via WebSocket (optional) and HTTP polling.
    - Schedules realtime block sync and block-check (reorg) jobs.

- Collection bootstrap runtime (`indexer/src/runtime/bootstrap-worker.ts`)
    - Consumes collection bootstrap jobs.
    - Auto-installs embedded collection extensions during bootstrap start when the bootstrap request matches a known embedded extension by contract plus token scope.
    - Orchestrates per-collection metadata snapshot, ownership snapshot, short backfill, and OpenSea bootstrap job emission.

- Collection extension runtime (`indexer/src/runtime/collection-extension-worker.ts`)
    - Consumes collection-extension artifact refresh jobs.
    - Loads enabled collection-extension installs and executes extension-specific artifact refresh logic.
    - Persists extension-owned token artifacts without blocking canonical metadata progress.

- Sync worker runtime (`indexer/src/runtime/sync-worker.ts`)
    - Consumes realtime/backfill sync jobs.
    - Fetches logs, decodes transfers/fills/cancels/counters, persists blocks/transfers/balances.
    - Fan-outs domain sync jobs and targeted order update jobs.

- Reorg worker runtime (`indexer/src/runtime/reorg-worker.ts`)
    - Consumes block-check jobs.
    - Detects reorgs and rolls back orphaned blocks.
    - Schedules backfill jobs to resync the rolled-back range.

- Domain worker runtime (`indexer/src/runtime/domain-worker.ts`)
    - Consumes domain jobs plus order upsert/update jobs.
    - Persists canonical orders, metadata, and activities.
    - Re-validates Seaport orders asynchronously from canonical order state.

- Offchain ingest runtime (`indexer/src/runtime/offchain-ingest-worker.ts`)
    - Consumes raw offchain order payloads.
    - Optionally stores raw observations for audit/debug.
    - Normalizes OpenSea stream and REST records into canonical order jobs.

- OpenSea stream runtime (`indexer/src/runtime/opensea-stream-worker.ts`)
    - Maintains per-collection stream subscriptions using persisted OpenSea slug.
    - Publishes raw OpenSea stream events into the offchain queue.
    - Tracks collection-level stream health timestamps.

- OpenSea bootstrap runtime (`indexer/src/runtime/opensea-bootstrap-worker.ts`)
    - Uses the persisted OpenSea slug from the collection row.
    - Starts initial full orderbook snapshot for a collection.
    - Marks OpenSea offchain readiness when the first snapshot run succeeds.

- OpenSea reconcile runtime (`indexer/src/runtime/opensea-reconcile-worker.ts`)
    - Runs full orderbook reconciliation passes for tracked collections.
    - Applies authoritative source-active/inactive updates at the source-status layer.

- OpenSea reconcile scheduler runtime (`indexer/src/runtime/opensea-reconcile-scheduler-worker.ts`)
    - Schedules periodic reconcile jobs.
    - Schedules immediate reconcile on startup for stale collections.

- Dead-letter runtime (`indexer/src/runtime/dead-letter-worker.ts`)
    - Consumes dead-letter jobs and logs terminal failures.

Queue broker:

- NATS + JetStream (external to the Node runtimes).

Database:

- SQLite, accessed through `@artgod/shared/database`.

## Core Invariants

These assumptions are relied on by the implementation and should be preserved in future work:

1. Only the scheduler-worker publishes realtime sync jobs.
2. Job handling is idempotent everywhere; at-least-once delivery is assumed.
3. No implicit full historical backfill runs on startup. Full backfills are user-triggered.
4. Runtime logic depends on ports (`indexer/src/ports/`); infra adapters implemented in `indexer/src/infra/`.
5. Configuration is explicit and loaded through typed env/config modules.
6. Raw OpenSea payloads persisted into SQLite are audit/debug-only for indexer/order validation. The trading bid-book fallback has one explicit read-only exception: it may parse `raw_rest_data`/`raw_stream_data` through the shared OpenSea bidding-offer parser to avoid inheriting stale order-scope classification.
7. `fillability_status` and `source_status` are separate concerns.
    - `fillability_status` is protocol/onchain executability.
    - `source_status` is source-visible activity from OpenSea snapshot/stream/reconcile.
8. OpenSea readiness is separate from collection `status = live`.
    - onchain `live` means bootstrap ownership/backfill is done.
    - OpenSea `ready` means the initial offchain snapshot has succeeded.
9. Collection extensions are build-bundled and DB-activated.
    - v1 supports at most one enabled extension install per collection.
    - bootstrap auto-installs known embedded extensions by `chain_id + contract + token_scope`.
10. Canonical metadata remains authoritative.
    - `token_metadata` and normalized attributes are the source of truth for token identity and traits.
    - extension artifact rows are secondary caches used for collection-specific behavior such as media overrides.
11. Collection-extension jobs are non-blocking side-effects.
    - extension failures must never fail canonical metadata writes, ownership bootstrap, or collection liveness.
12. Collection-extension sync hooks are intentionally narrow in v1.
    - extension watch specs may currently normalize only into metadata refresh events/ranges.

## High-Level Data Flow

### Onchain flow

1. Scheduler-worker observes head updates.
2. Scheduler-worker publishes `events-sync-realtime` jobs for each new block.
3. Sync worker consumes sync jobs:
    - fetches blocks/logs/transactions/receipts
    - decodes transfers, fills, cancels, and maker triggers
    - writes blocks/transfers/fills/balances
    - publishes domain sync jobs and targeted order update jobs
4. Domain worker consumes domain jobs and targeted order jobs:
    - orders domain persists canonical orders and updates `fillability_status`
    - metadata domain fetches and stores token metadata
    - activity domain writes activity rows
    - successful metadata writes fan out collection-extension artifact refresh jobs when an enabled install exists
5. Scheduler-worker publishes `block-check` jobs once blocks are old enough.
6. Reorg worker verifies block hashes and rolls back on mismatch.

### OpenSea offchain flow

1. Bootstrap completes local metadata + ownership capture for a collection.
2. Bootstrap schedules short onchain backfill and an OpenSea bootstrap job in parallel.
3. OpenSea bootstrap worker resolves OpenSea slug, marks offchain snapshot running, and streams the full orderbook through the offchain raw queue.
4. OpenSea stream worker maintains live subscriptions for `live` collections with known OpenSea slug and publishes raw events into the same offchain raw queue.
5. Offchain ingest worker records raw observations and normalizes:
    - canonical order upserts
    - source-status updates by order id
    - maker revalidation hints
    - metadata refresh hints
6. Domain worker persists canonical orders, then validates Seaport orders asynchronously from canonical `seaport_data_json`.
7. OpenSea reconcile worker periodically re-fetches the full orderbook and marks locally active-but-missing orders `source_status = inactive`.

### Collection extension flow

1. Bootstrap request resolution checks whether the collection contract plus token scope matches an embedded extension definition, persists the requested extension key on the run, and bootstrap start upserts a `collection_extension_installs` row before metadata snapshot work begins.
2. Any successful canonical metadata write can publish `collection-extension.refresh-artifacts` on the dedicated `collection-extension-artifacts` queue.
3. Collection extension worker resolves the enabled install and executes extension-specific artifact refresh logic against normalized token state and onchain/metadata ports.
4. Extension artifact results are upserted into `token_extension_artifacts`.
5. Backend read paths can resolve effective collection-specific presentation from extension artifacts while frontend components remain generic.

Current embedded extension:

- `terraforms`
    - watches collection-specific onchain events and normalizes them into metadata refresh triggers
    - caches Terraforms version-2 renderer artifacts in `token_extension_artifacts`
    - drives backend media overrides for token cards and token detail pages

## Eventual Consistency Notes

OpenSea snapshot/reconcile completion currently means:

- the REST fetch completed
- raw records were published to the offchain queue
- source-active/inactive reconciliation for the run was applied

It does **not** mean every published order has already completed downstream upsert + validation. The local orderbook converges through the queue pipeline shortly after the snapshot/reconcile run completes.

Collection-extension artifact completion is similarly eventual:

- canonical metadata is committed first
- extension jobs run afterward on their own queue
- backend overrides converge once the artifact refresh worker completes

## Current Limits and Planned Evolution

Collection extensions intentionally ship as a narrow first pass:

- one enabled extension install per collection
- build-bundled code only; no remote or onchain-loaded extension source yet
- bootstrap auto-install exists, but operator-driven install/uninstall flows are not implemented yet
- sync hooks currently emit only metadata refresh triggers
- collection-extension artifact readiness is not tracked separately from canonical collection/bootstrap readiness

## Code Map

The most important directories:

- `indexer/src/runtime/`: process entrypoints and orchestration
- `indexer/src/application/`: worker logic, normalization, validation, scheduling helpers
- `indexer/src/domain/`: job and data model definitions
- `indexer/src/ports/`: contracts used across runtimes
- `indexer/src/infra/`: queue, RPC, storage, cache, OpenSea, and domain adapters
- `database/migrations/`: SQLite schema
- `indexer/tests/`: unit, DB-backed, and smoke tests

See `docs/indexer/14-collection-bootstrap.md` for the per-collection bootstrap sequence, `docs/indexer/15-fill-decoding.md` for sale/fill decoding semantics, and `docs/indexer/13-sequence-diagrams.md` for the key end-to-end flows.
