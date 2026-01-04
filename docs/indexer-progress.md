# ArtGod Indexer Progress Tracker

This document tracks the execution plan for the ArtGod indexer, derived from the blueprint. It is intentionally granular and sequenced so we can ship a minimal, working implementation and iterate layer-by-layer.

## Decisions & Constraints (Current)

- Local-first, no centralized services; all infra runs on the user's machine.
- NATS + JetStream is the durable queue backend from day one.
- Separate runtimes: event emitters and queue consumers are independent processes.
- Ports & adapters everywhere (RPC, queues, storage, cache); no direct coupling.
- Jobs are idempotent across processes; at-least-once delivery is assumed.
- Reorg handling starts with "reprocess last N blocks" and evolves later.
- Short-lived in-memory cache is OK, but cache metrics must be tracked.
- Single target collection at first, but architecture supports many from the start.

## Runtime Topology (Planned)

- `indexer-scheduler`: polls chain head, schedules sync/backfill jobs.
- `indexer-sync-worker`: consumes sync jobs, parses logs, persists on-chain data.
- `indexer-domain-workers`: consume derived jobs (orders, metadata, activities).
- `queue-broker`: local NATS server with JetStream enabled.
- `database`: SQLite for all state and indexer data.

Cross-process boundary: only through queues and shared storage ports.

## Queue Contract (Initial)

- `events-sync-realtime`: one job per new block (head-driven).
- `events-sync-backfill`: batched range jobs.
- `block-check`: delayed reorg verification (later).
- `orders-*`, `metadata-*`, `activity-*`: domain queues (later).

Job envelope (baseline):
- `jobId`, `kind`, `queue`, `payload`, `attempt`, `scheduledAt`, `traceId`,
  `collectionId`, `chainId`.

## Config Surface (Initial)

- Chain ID
- RPC URLs (primary + backfill)
- Target collections (address, start block)
- Reorg depth / confirmations depth
- Backfill batch size / log chunk size
- Queue config (NATS URL, stream names, consumer names)

## Observability (Initial)

- Structured logs: `component`, `action`, JSON records.
- Cache metrics: hit/miss rate, latency, size, evictions.
- Queue metrics: enqueue rate, dequeue rate, ack latency, retry count.
- Sync metrics: block lag, logs per block, parse errors.

## Contracts & Verification

- For each layer/runtime, define cross-process contracts early.
- Prefer tests to lock behavior; use schema files when it enables docs or codegen.
- Each contract must have a single source of truth and a runnable verification path.

## Roadmap (Granular)

Legend: [ ] not started, [~] in progress, [x] done

### Phase 0 - Foundations

- [x] Define `indexer/` module layout (domain/application/infra).
- [x] Add shared types for job envelopes and queue names.
- [x] Define config loader + validation (env + defaults).
- [x] Define metrics interface (counter, gauge, histogram).
- [x] Add minimal ABI registry (ERC721/1155 Transfer).

### Phase 1 - Queue Infrastructure (NATS + JetStream)

- [x] Define `QueuePort` interface (publish, consume, ack, nack, delay).
- [x] Define retry policy (backoff schedule, max attempts, DLQ).
- [x] Implement NATS JetStream adapter.
- [x] Implement worker runner (concurrency, shutdown, lease extension).
- [x] Create queue naming convention + stream/consumer mapping.
- [x] Create runtime entrypoints:
  - `indexer-scheduler`
  - `indexer-sync-worker`
  - `indexer-domain-worker`

### Phase 2 - RPC & Chain Access

- [x] Define `RpcProviderPort` (getBlock, getLogs, getTx).
- [x] Implement viem-based adapter with rate limiting.
- [x] Add basic in-memory cache + metrics hooks.
- [x] Add log chunking and backoff defaults.

### Phase 3 - Sync Pipeline (Minimal On-Chain)

- [ ] Implement block poller (head tracking, enqueue realtime jobs).
- [ ] Implement backfill range scheduler (batching).
- [ ] Implement sync worker:
  - [ ] Fetch block + logs
  - [ ] Decode ERC721/1155 Transfer logs
  - [ ] Group by tx (if needed)
  - [ ] Accumulate `OnChainData` (transfers, balance deltas)

### Phase 4 - Persistence (SQLite)

- [ ] Define minimal schema (blocks, sync_state, nft_transfer_events, nft_balances).
- [ ] Add migrations.
- [ ] Implement storage adapter (batch inserts + upserts).
- [ ] Add idempotency constraints (tx_hash + log_index, etc).

### Phase 5 - Reorg Handling (Minimal)

- [ ] Track recent block hashes in DB.
- [ ] Reprocess last N blocks on each new head.
- [ ] Add optional `block-check` job (delayed verification).

### Phase 6 - Domain Skeletons (Orders / Metadata / Activities)

- [ ] Define domain handler ports and empty adapters.
- [ ] Create queue definitions and no-op workers.
- [ ] Wire fan-out from sync worker to domain queues.

### Phase 7 - Orders Domain (First Pass)

- [ ] Define minimal order event model.
- [ ] Implement on-chain order event capture (if applicable).
- [ ] Persist order state tables (lean subset of blueprint schema).

### Phase 8 - Metadata Domain (First Pass)

- [ ] Token URI fetcher port + adapter.
- [ ] Metadata normalization and persistence.
- [ ] Metrics for fetch latency and failures.

### Phase 9 - Activities Domain (First Pass)

- [ ] Define activity event model.
- [ ] Produce activity events from transfers/fills.
- [ ] Persist activity feed.

### Phase 10 - Hardening

- [ ] Dead-letter handling & inspection tooling.
- [ ] Graceful shutdown semantics (flush + ack).
- [ ] Smoke tests with local node.
- [ ] Baseline load test (block spike).

## Open Questions / Notes

- Finalize queue naming and stream retention policies for JetStream.
- Define per-collection bootstrap and cleanup workflow.
- Decide on confirmation depth defaults for Ethereum.
