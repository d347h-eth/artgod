# ArtGod Indexer Overview

This document describes the current indexer architecture and the main invariants the system relies on. It is meant to give a new contributor a complete mental model before diving into the individual components.

## Purpose and Scope

The indexer is a local-first pipeline that reads blockchain data and builds a local queryable state for the ArtGod app. It is designed as a minimal but production-shaped system:

- All processing runs locally on the user's machine.
- All cross-process communication goes through a durable queue (NATS JetStream).
- All persisted state lives in SQLite (better-sqlite3).
- Every job is idempotent; at-least-once delivery is assumed.

The system currently focuses on on-chain NFT transfer data (ERC721 and ERC1155), plus early-stage domain projections (orders invalidation, metadata fetch, activity feed).

## Runtime Topology

Each runtime is an independent Node.js process. There is no shared memory across runtimes.

- Scheduler-worker runtime (`indexer/src/runtime/scheduler-worker.ts`)
    - Tracks chain head via WebSocket (optional) and HTTP polling.
    - Schedules realtime block sync and block-check (reorg) jobs.

- Collection bootstrap runtime (`indexer/src/runtime/bootstrap-worker.ts`)
    - Consumes collection bootstrap jobs.
    - Orchestrates per-collection bootstrap steps (anchor snapshot + short backfill).

- Sync worker runtime (`indexer/src/runtime/sync-worker.ts`)
    - Consumes realtime/backfill sync jobs.
    - Fetches logs, decodes transfers, persists blocks/transfers/balances.
    - Fan-outs domain jobs (orders, metadata, activities).

- Reorg worker runtime (`indexer/src/runtime/reorg-worker.ts`)
    - Consumes block-check jobs.
    - Detects reorgs and rolls back orphaned blocks.
    - Schedules backfill jobs to resync the rolled-back range.

- Domain worker runtime (`indexer/src/runtime/domain-worker.ts`)
    - Consumes domain jobs (orders, metadata, activities).
    - Writes domain-specific tables derived from transfer events.

- Offchain ingest runtime (`indexer/src/runtime/offchain-ingest-worker.ts`)
    - Consumes raw offchain order payloads.
    - Validates and normalizes them into order upsert jobs.

- OpenSea stream runtime (`indexer/src/runtime/opensea-stream-worker.ts`)
    - Replays OpenSea fixture payloads into the raw offchain queue (stub).

- Dead-letter runtime (`indexer/src/runtime/dead-letter-worker.ts`)
    - Consumes dead-letter jobs and logs failures.

Queue broker:

- NATS + JetStream (external to the Node runtimes).

Database:

- SQLite, accessed through `@artgod/shared/database`.

## Core Invariants

These are the assumptions that the implementation relies on and should be preserved in future work:

1. **Only the scheduler-worker publishes realtime sync jobs.**
    - WebSocket listeners and pollers can notify the scheduler-worker, but the scheduler-worker is the sole publisher.

2. **Idempotent processing everywhere.**
    - Jobs can be redelivered; persistence uses unique constraints and upserts.

3. **No implicit full historical backfill on startup.**
    - Startup schedules only the recent reorg window. Full backfills are user-triggered.

4. **Ports and adapters at process boundaries.**
    - Runtime logic depends on interfaces in `indexer/src/ports/`.
    - Infrastructure implementations live in `indexer/src/infra/`.

5. **Explicit configuration and contracts.**
    - Config is loaded from `.env` into explicit TypeScript objects.
    - Cross-process contracts are defined in domain types and job envelopes.

## High-Level Data Flow

1. Scheduler-worker observes head updates.
2. Scheduler-worker publishes `events-sync-realtime` jobs for each new block.
3. Sync worker consumes sync jobs:
    - Fetches block + logs.
    - Decodes transfers.
    - Writes blocks/transfers/balances.
    - Publishes domain jobs for the same range.
4. Domain worker consumes domain jobs:
    - Orders domain invalidates orders based on transfers.
    - Metadata domain fetches and stores token metadata.
    - Activity domain writes activity records.
5. Scheduler-worker publishes `block-check` jobs once blocks are old enough.
6. Reorg worker verifies block hashes and rolls back on mismatch.

This flow is designed to be minimal and durable without requiring centralized services.

Offchain orders follow a separate ingestion path (raw queue → normalize → orders upsert) and then join the same order maintenance pipeline.

## Code Map

The most important directories:

- `indexer/src/runtime/`: process entrypoints and orchestration.
- `indexer/src/application/`: shared runtime logic (scheduler-worker, sync, worker runner).
- `indexer/src/ports/`: contracts used across runtimes.
- `indexer/src/infra/`: queue, RPC, storage, cache, and domain adapters.
- `indexer/src/domain/`: job and data model definitions.
- `database/migrations/`: SQLite schema.
- `indexer/tests/`: smoke test and test helpers.

The rest of the docs in this folder go deeper into each segment.

See `docs/indexer/14-collection-bootstrap.md` for the per‑collection bootstrap sequence (ownership snapshot + short backfill) that replaces full historical backfill for normal usage.
