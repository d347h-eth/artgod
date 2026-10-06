# Scheduler-Worker Runtime

The scheduler-worker translates chain head updates into sync and reorg jobs and continuously repairs missing coverage for live collections. It is the only component allowed to publish realtime sync jobs.

Implementation:

- `indexer/src/application/scheduler-worker.ts` (core logic)
- `indexer/src/application/sync-gap-scheduler.ts` (collection coverage sweeps)
- `indexer/src/infra/storage/sqlite-sync-gaps.ts` (durable scan and repair state)
- `indexer/src/runtime/scheduler-worker.ts` (runtime entrypoint)

## Inputs

- RPC provider (HTTP): used to fetch the current head.
- Optional WebSocket head source: emits head updates.
- Queue port: publishes jobs to NATS.
- Collection registry and gap store: read eligible collections and their coverage, and retain repair intent in SQLite.

## Bootstrap Sequence

`startSchedulerWorker()` performs a blocking bootstrap before starting any background loops:

1. Fetch current head via `rpc.getBlockNumber()`.
2. Schedule realtime sync jobs for the recent reorg window only.
3. Schedule the initial block-check job for reorg validation.
4. Set `lastScheduled` and `lastChecked` based on the head.
5. Run one bounded collection gap scan using that observed head.

This ensures the scheduler-worker never publishes from an uninitialized head.

## Realtime Scheduling

- The scheduler-worker maintains `lastScheduled` (last head seen and scheduled).
- On each head update, it schedules jobs from `lastScheduled + 1` to `head`.
- Jobs are published to `events-sync-realtime` with dedupe by jobId.
- WS and HTTP scheduling share a serialized cursor; overlapping polls are coalesced.

Important invariant:

- The realtime window is always relative to the latest head.
- Automatic gap repairs run separately from the realtime window and use each live collection's anchor as their lower bound.

## Reorg Block Checks

Block-check jobs are scheduled after blocks become old enough to be safe from shallow reorgs.

- `reorgDepth` determines the delay.
- The scheduler-worker increments `lastChecked` and schedules `block-check` jobs in order.

If scheduling would fall below block 1, the scheduler-worker logs a warning and skips the check.

`lastChecked` tracks scheduled checks, not completed recovery. The reorg worker
retains a detected mismatch separately and resumes due proof/resync at startup
and periodically, including at stationary HEAD. Collection gap sweeps can fill
missing ancestor headers; covered orphan blocks still require that retained
[reorg recovery](06-reorg-handling.md#durable-recovery-lifecycle).

## Head Sources

The scheduler-worker supports two head sources:

1. **WebSocket head source** (`ViemWebSocketHeadSource`)
    - Non-blocking, event-driven.
    - Emits heads to the scheduler-worker as soon as the node announces them.

2. **HTTP poller**
    - Runs on a fixed interval (default 12s).
    - Authoritative: fills gaps if the WS path misses a block.

The WS path and poller both call the same `handleHead()` function.

## Perpetual Collection Gap Repair

Gap detection is enabled by default. Startup and every successful HTTP poll
(default 12 seconds) run a bounded pass, including when the head is unchanged.
Each pass visits at most 16 eligible collections in collection-ID order, rotating
through the full set. Only `live` collections with a valid bootstrap anchor
participate. Newly live collections join automatically; prepared, bootstrapping,
paused, disabled, and unanchored collections are excluded.

For each collection, the scanner reads at most a 10,000-block window of
`collection_sync_blocks`, walking backward from the observed head to
`bootstrap_anchor_block`, inclusive. It streams the indexed coverage rows and
selects the highest contiguous gap, capped by `BACKFILL_BATCH_SIZE`. Global
`blocks` rows and `bootstrap_last_synced_block` are not coverage evidence. A
persisted cursor prevents newer heads or scheduler restarts from resetting the
backward sweep; after the anchor it starts another sweep from the current head.

Before publishing, the scheduler saves the next scan position and repair intent
in `collection_sync_gap_scans`. There is at most one outstanding logical repair
per collection. After retaining that page's intents, the scheduler groups ranges
with the same upper block into descending batches capped by `BACKFILL_BATCH_SIZE`.
The shared range starts at the highest member start or the block-size limit,
whichever is later. This common suffix is inside every participating intent;
it does not fetch another participant's already covered history just to widen
the batch. For A pending 101–110 and B pending 110 alone, block 110 is shared
and A retains 101–109 for a later pass.
Each `gap_repair` job explicitly carries its members' collection IDs, repair IDs,
anchors and expected remaining ranges, with `current_state` order maintenance.
It uses the existing backfill queue and multi-collection sync pipeline. Identical
gaps share header, log and transaction/receipt acquisition. Different upper
bounds remain separate in that pass; at most 16 collections participate.
The anchor block itself remains facts-only under the existing projection guard.

The sync worker rechecks each member's persisted repair identity, remaining
bounds, liveness and anchor inside its execution gate. Stale members are excluded;
no active members means no RPC work. One acquisition persists collection-specific
coverage for the admitted members. Domain range jobs remain collection-scoped;
shared event fanout, including global order hints, runs once.
Retained intent, rather than missing coverage alone, determines the needed range:
a failed fanout can require replay even after coverage has been written.

Only after all required publications succeed does each member complete, or retain
its older unfinished range if the bounded batch covered only its newest portion.
The repair ID survives partial progress. Conditional writes fence late completion
and publication responses by repair ID, anchor and expected bounds. New batches
use a deterministic job ID from their range and sorted membership; unchanged
publication retries reuse it after restart. Already completed or replaced members
become no-ops. A failed publication leaves the same intents due; an accepted but
unfinished batch is republished after five minutes. This
also redrives dead-lettered work. Broker redelivery and retry publications may
produce duplicate deliveries; they do not admit additional logical ranges.

These limits belong to `SYNC_GAP_POLICY`; the runtime uses the existing typed
`BACKFILL_BATCH_SIZE` setting for repair size. A failing collection does not stop
other batches. A persistent failure in one batch holds its members' sweeps until
repair succeeds. Reorg coverage deletions and new holes behind a
cursor are discovered on a subsequent sweep. Shutdown drains active scheduling
and scan work before closing the queue.

Coverage establishes successful onchain range ingestion. It does not prove that
an RPC provider returned every expected log, or that downstream domain workers
have finished consuming the published jobs.

## Scheduler Ownership and Deferred Coordination

Normal runtime composition creates one scheduler per chain. Its serialized head
cursor and active gap-scan promise coordinate only that process. The sync
worker's backfill execution gate is also process-local; realtime work is outside
it. Transactional chain revisions and affected-token checks reject stale writes
across rollback, but do not provide exclusive admission between independent
scheduler instances.

Concurrent scheduler failover is not an established deployment contract. Adding
a distributed lock is outside the perpetual gap-detection change. If that
deployment becomes supported, define durable database claims and conditional
updates for scan/repair admission, with expired-owner fencing, stable logical
repair identity, and restart/duplicate-delivery tests. Preserve bounded work and
avoid treating an in-memory mutex as cross-process coordination. This conditional
future work stays under `BKL-018` in the
[unified backlog](../planning/01-unified-backlog.md).

## Manual Backfills

History before the bootstrap anchor and other operator-selected ranges remain manual.

Operators can schedule a range through either current inbound adapter:

- Admin calls `POST /api/{chain_ref}/blockspace/backfill`;
- `indexer/scripts/trigger-backfill.ts` provides the CLI path.

The backend use case validates and splits the requested range; its outbound
queue adapter and the CLI build explicit `manual_historical` jobs for
`events-sync-backfill`. Their payload selects
`skip_global_maker_revalidation`, preserving historical facts and token-scoped
effects without treating old WETH/counter events as current maker state.

## Runtime Entrypoint

`indexer/src/runtime/scheduler-worker.ts` wires the ports:

- Loads config from `.env`.
- Applies migrations and opens collection coverage and durable gap-scan adapters.
- Connects to NATS.
- Initializes in-memory cache for RPC calls.
- Creates HTTP RPC provider and optional WS head source.
- Starts the scheduler-worker and installs shutdown handlers.
