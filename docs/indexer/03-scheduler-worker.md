# Scheduler-Worker Runtime

The scheduler-worker translates chain head updates into sync and reorg jobs while the sync worker discovers and repairs missing collection coverage. It is the only component allowed to publish realtime sync jobs.

Implementation:

- `indexer/src/application/scheduler-worker.ts` (core logic)
- `indexer/src/application/sync-gap-scheduler.ts` (collection coverage sweeps)
- `indexer/src/infra/storage/sqlite-sync-gaps.ts` (durable scan and repair state)
- `indexer/src/runtime/scheduler-worker.ts` (runtime entrypoint)

## Inputs

- RPC provider (HTTP): used to fetch the current head.
- Optional WebSocket head source: emits head updates.
- Queue port: publishes jobs to NATS.

## Bootstrap Sequence

`startSchedulerWorker()` performs a blocking bootstrap before starting any background loops:

1. Fetch current head via `rpc.getBlockNumber()`.
2. Schedule realtime sync jobs for the recent reorg window only.
3. Schedule the initial block-check job for reorg validation.
4. Set `lastScheduled` and `lastChecked` based on the head.

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
retains a detected mismatch separately and resumes due proof at startup
and periodically; the sync worker executes retained resync ranges, including at stationary HEAD. Collection gap sweeps can fill
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

Gap detection is enabled by default in the sync worker. Its automatic executor
finds gaps and fetches/saves blocks continuously, including at stationary HEAD.
After a successful repair or a discovery page with more history to check, it
yields to runtime work and starts the next pass immediately. A completed sweep,
retry backoff, RPC lag, or paused allocation uses the 12-second idle poll.
Local-only discovery reuses a HEAD observed within 12 seconds; every
fetch-and-save batch reads a fresh HEAD before choosing its range. An app
without eligible collections sends no automatic gap HEAD requests.
Each pass visits at most 16 eligible collections in collection-ID order, rotating
through the full set. Only `live` collections with a valid bootstrap anchor
participate. Newly live collections join automatically; prepared, bootstrapping,
paused, disabled, and unanchored collections are excluded.

For each collection, the scanner reads at most a 10,000-block window of
`collection_sync_blocks`, walking backward from the observed head to
`bootstrap_anchor_block`, inclusive. It streams the indexed coverage rows and
selects the highest contiguous gap, capped by `BACKFILL_BATCH_SIZE`. Global
`blocks` rows and `bootstrap_last_synced_block` are not coverage evidence. A
persisted cursor keeps ordinary polling and restarts from resetting the backward
scan; after the anchor it starts another scan from the current head.

Every 30 minutes of wall-clock time, the sync worker checks for newer holes
above each collection's pending range, or above its cursor when no range is
pending. `last_head_check_at` persists this timing, so downtime counts and overdue
checks run after restart. Previously unchecked rows are due immediately. A
normal scan starting at HEAD also records this time; continuing older history
does not postpone it. Each check pass handles at most 16 due collections.

The fresh RPC HEAD filters out anchors above HEAD before those 16 rows are
selected. HEAD-check passes advance through indexed check-time/collection order
even when a whole page fails or is skipped after selection. They wrap after
reaching the end, with a fixed due-time cutoff during each traversal so rows
becoming due again cannot prevent that wrap. This position is process-local and
resets on restart; it does not change the persisted backward cursor or mark
unperformed checks fresh. Failed and skipped checks retain their timestamps and
can be retried without blocking later collections.

HEAD checks use indexed coverage counts and binary subdivision to find the
newest missing block across the full newer span, then stream at most one
repair-sized suffix to find its contiguous boundary. All those reads share one
SQLite read snapshot. They create no additional coverage table and make no
per-block RPC calls. The ordinary backward scan keeps its 10,000-block bound.

If no newer hole exists, only the check time changes. The existing cursor,
pending identity, bounds and retry time stay intact. If a newer hole exists, it
replaces the pending range and moves the cursor just below that range. Older
holes remain absent from coverage and will be rediscovered by backward scanning.
Checks and replacement run inside the shared backfill gate, between attempts to
fetch and save blocks. A running attempt finishes first; work waiting for the
gate is selected again when it can start. Slow RPC or another current-state
backfill can delay a due check; 30 minutes defines eligibility, not a deadline.
Conditional progress saves fence changed collection/repair state before commit.

The scanner, owned by the sync worker, saves the next scan position and one repair intent per collection
in `collection_sync_gap_scans`. It publishes no automatic range job. The sync
worker's `AutomaticSyncExecutor` reads due intent directly, running at most one
range per pass and immediately continuing while work progresses. It finds the globally highest
pending upper bound across live collections, then reads at most 16 ready members
at that height. Their common suffix is shared and the range is capped by
`BACKFILL_BATCH_SIZE`. Retry eligibility is applied after finding the highest
pending height: if that height is waiting for retry or exceeds the RPC head,
older history waits. Other ready members at that same height may still run.
Both selection and HEAD-check scheduling use ordered indexes with SQL limits;
there is no unbounded candidate list. Automatic range selection has no paging
cursor; the HEAD checker alone advances its process-local check position.
`BACKFILL_WORKER_COUNT` controls queued backfills, not this serial automatic loop.
For A pending 101–110 and B pending 110 alone, block 110 is shared and A retains
101–109. Different upper bounds remain separate. Identical gaps share headers,
logs and transaction/receipt reads; covered peers stay outside older remainders.

The executor rechecks member liveness, anchor, repair ID and exact remaining
bounds after entering the current-state gate. The sync commit rechecks those
members again inside its SQLite writer. It atomically writes facts, coverage,
anchor-gated balances, all required downstream publication intent and matching
repair progress. A failed data, follow-up or progress write rolls back all of
these. The anchor itself remains facts-only. Partial progress retains the same
repair ID with its older contiguous remainder.

Acquisition completion clears or advances repair intent. Domain-worker drains
the required follow-ups from `queue_outbox` separately; publication failures
retry there without reacquiring RPC data. Failed acquisition defers its exact
members for five minutes, retaining newest-height priority. Old queued gap
hints are acknowledged without acquisition; upgrade retains their SQLite intent.

Scan limits belong to `SYNC_GAP_POLICY`, executor timing to
`AUTOMATIC_SYNC_POLICY`; the runtime uses the existing typed
`BACKFILL_BATCH_SIZE` setting for repair size. A persistent failure at the newest
height holds older automatic ranges until it succeeds or newer work replaces
it. Reorg coverage deletions and new holes above a cursor are discovered by the
periodic HEAD check; holes below it are found by backward scanning. Shutdown
drains active scheduling and scan work before closing the queue.

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
- Applies migrations.
- Connects to NATS.
- Initializes in-memory cache for RPC calls.
- Creates HTTP RPC provider and optional WS head source.
- Owns the pipeline's shared RPC allowance, then starts head scheduling and
  installs shutdown handlers. See [RPC allocation](04-sync-pipeline.md#rpc-allocation).
