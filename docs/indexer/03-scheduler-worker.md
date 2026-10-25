# Scheduler-Worker Runtime

The scheduler-worker samples remote chain heads and retains targets for the sync
coordinator. It publishes realtime wakeups; those messages never authorize a
particular block to be applied. The sync coordinator owns forward application,
collection catch-up and reorg recovery.

Implementation:

- `indexer/src/application/scheduler-worker.ts` (core logic)
- `indexer/src/application/sync-gap-scheduler.ts` (collection coverage sweeps)
- `indexer/src/infra/storage/sqlite-sync-gaps.ts` (durable scan and repair state)
- `indexer/src/runtime/scheduler-worker.ts` (runtime entrypoint)

## Inputs

- RPC provider (HTTP): used to fetch the current head.
- Optional WebSocket head source: emits head updates.
- Queue port: publishes jobs to NATS.

## Head Sampling and Wakeups

`startSchedulerWorker()` captures the local admission watermark and chain
revision before a fresh HTTP head-number/header read. It stores that sample
before publishing the bounded recent realtime wakeup tail. A sample from a
superseded revision cannot commit. The target remains executable after a lost
publication or scheduler restart.

The HTTP poller repeats this sequence every 12 seconds, including at stationary
HEAD. A source observation arriving during the read is excluded from its captured
watermark and waits for a later sample. This supplies the source-neutral
admission barrier without per-order head or receipt RPC.

The optional WebSocket source only schedules wakeups. Its notifications cannot
satisfy admission requirements; the next fresh HTTP sample does that. WS and HTTP
scheduling share a serialized `lastScheduled` cursor, and overlapping HTTP polls
are coalesced. Queue job IDs remain deduplicated by chain and height.

The queue's recent window bounds notification volume, not the amount of required
catch-up. The coordinator always selects the next block after durable applied
progress, even when an earlier wakeup was missed. Shared chain progress and each
accepted collection prefix advance independently, in order. Neither is paused by
`GAP_FILL_MODE=disabled`.

## Reorg Checks

The scheduler has no hash-check cursor or queue. Saving recent blocks atomically
retains their delayed checks in SQLite. The sync coordinator drains eligible rows
even after downtime moves them outside the realtime tail, then retains and
resolves any mismatch. See [pending hash checks](06-reorg-handling.md#pending-hash-checks).

## Perpetual Collection Gap Repair

Historical gap detection is enabled by default in the sync worker. The same
coordinator runs it when no foreground range is ready, including at stationary
HEAD. This lane imports facts and activity only; it never advances applied
progress, ownership or current order effects.
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
`collection_sync_blocks`, walking backward from `HEAD - REORG_DEPTH` to
`bootstrap_anchor_block`, inclusive. It streams the indexed coverage rows and
selects the highest contiguous gap, capped by `BACKFILL_BATCH_SIZE`. Global
`blocks` rows and `bootstrap_last_synced_block` are not coverage evidence. A
persisted cursor keeps ordinary polling and restarts from resetting the backward
scan. Reaching the anchor marks that collection complete for the current cycle.
A complete cycle waits for newly eligible blocks or its next 30-minute recheck
instead of restarting completed history while another collection finishes. Changed anchors, new
live collections and rollback start their required discovery again.

Every 30 minutes of wall-clock time, the sync worker checks up to `HEAD - REORG_DEPTH` for newer holes
above each collection's pending range, or above its cursor when no range is
pending. `last_head_check_at` persists this timing, so downtime counts and overdue
checks run after restart. In addition, startup and reenabling gap filling check
newer history once regardless of the saved timer, before older automatic repair
starts. This check traverses live collections by ID in pages of at most 16; its
position is process-local, and failed/skipped members do not prevent later pages.
Reenabling is a restart-required setting, so both paths use the same startup
check. Previously unchecked rows are due immediately. A
normal scan starting at HEAD also records this time; continuing older history
does not postpone it. Each check pass handles at most 16 due collections.

When the observed `HEAD - REORG_DEPTH` advances, the worker also checks only
`(last successfully checked eligible block, new upper bound]` per collection.
Those positions live in memory and are seeded by successful startup, broader
HEAD checks or ordinary discovery beginning at HEAD. Collection pages have a
fixed upper bound and at most 16 members; every page finishes before older repair
is selected. If HEAD advanced between pages, the next bounded traversal checks
the additional strip first. Failed checks advance pagination and retain their
old positions for retry after the traversal. Regressed provider heads do not
move checked positions backward or replace a newer pending repair.

Covered strips require no progress-row write. A newer hole replaces the pending
range through the same conditional save as broader checks, preserving the
independent `last_head_check_at` timer. Incremental checks therefore cannot
postpone the broader 30-minute lookup. Rollback clears local positions; changed
anchors are initialized by ordinary discovery. This adds no persistent state
and uses the executor's existing HEAD reads, with no additional blockchain RPC.

Periodic HEAD-check pages use fresh RPC HEAD to filter out anchors above HEAD
before those 16 rows are selected. They advance through indexed check-time/collection order
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

If a broader HEAD check finds no newer hole, only the check time changes. The existing cursor,
pending identity, bounds and retry time stay intact. If a newer hole exists, it
replaces the pending range and moves the cursor just below that range. Older
holes remain absent from coverage and will be rediscovered by backward scanning.
Checks and replacement run inside the shared backfill gate, between attempts to
fetch and save blocks. A running attempt finishes first; work waiting for the
gate is selected again when it can start. Slow RPC or foreground catch-up
can delay a due check; 30 minutes defines eligibility, not a deadline.
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
bounds before acquisition. The sync commit rechecks those members inside its
SQLite writer, together with the accepted shared-chain boundary. It atomically
writes facts, coverage, required activity publication intent and matching repair
progress. A failed data, follow-up or progress write rolls back all of these.
Partial progress retains the same repair ID with its older contiguous remainder.

Acquisition completion clears or advances repair intent. Domain-worker drains
the required follow-ups from `queue_outbox` separately; publication failures
retry there without reacquiring RPC data. Failed acquisition defers its exact
members for five minutes, retaining newest-height priority. The retained SQLite
intent is the only automatic gap-work handoff; no broker range format is needed.

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
worker's active coordinator pass is process-local. Durable expected-prefix and revision
checks reject stale or out-of-order current-state commits, including across
rollback. They do not provide exclusive RPC acquisition across independently
started coordinators.

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
`events-sync-backfill`. These jobs import historical facts and
activities only; current order maintenance belongs to accepted coordinator
ranges and ordinary validation demand.

## Runtime Entrypoint

`indexer/src/runtime/scheduler-worker.ts` wires the ports:

- Loads config from `.env`.
- Applies migrations.
- Connects to NATS.
- Initializes in-memory cache for RPC calls.
- Creates HTTP RPC provider and optional WS head source.
- Owns the pipeline's shared RPC allowance, then starts head scheduling and
  installs shutdown handlers. See [RPC allocation](04-sync-pipeline.md#rpc-allocation).

### Automatic history boundary and completed searches

Both backward discovery and the 30-minute newer-hole check end at
`HEAD - REORG_DEPTH`. The latest `REORG_DEPTH` blocks stay outside historical discovery; foreground
application covers every required block through its retained target.
Before fetching a repair, the executor rechecks at most one batch-sized coverage
window per member. Covered suffixes are removed locally; older unfinished
blocks and the saved scan cursor remain intact. Only still-missing common
suffixes share RPC work. Foreground collection catch-up may reuse facts already imported by history.
Applied progress, rather than fact insertion, authorizes its effects exactly once.

A completed collection stays finished while peers search older windows. This
completion bookkeeping is process-local. A completed cycle restarts after
30 minutes; a process restart resumes saved cursors, and a chain revision change
restarts discovery from the current history boundary. New collections and
changed anchors can join immediately. Fully covered mixed cursors converge to
idle instead of repeatedly restarting finished peers.
